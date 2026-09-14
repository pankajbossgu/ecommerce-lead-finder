import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { connectDatabase, env, Lead, SearchHistory, SearchJob } from './models.js';
import { runDiscovery } from './services.js';
import { AppError, applyDateRange, assertLeadStatus, logger, parseDateRange, parseDiscoveryInput, parsePagination } from './utils.js';

const app = express();
const publicDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public');
const allowedOrigins = env.appOrigin.split(',').map((origin) => origin.trim()).filter(Boolean);
const discoveryRateLimit = rateLimit({ windowMs: env.rateLimitWindowMs, limit: env.rateLimitMax, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many discovery requests. Please try again later.' } });

function requestOrigin(req) {
  const protocol = req.get('x-forwarded-proto')?.split(',')[0].trim() || req.protocol;
  const host = req.get('host');
  if (!['http', 'https'].includes(protocol) || !host) return null;

  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return null;
  }
}

export function isAllowedCorsOrigin(origin, req, configuredOrigins = allowedOrigins) {
  return !origin || configuredOrigins.includes(origin) || origin === requestOrigin(req);
}

export function corsOptionsForRequest(req) {
  return {
    origin(origin, callback) {
      if (isAllowedCorsOrigin(origin, req)) return callback(null, true);
      return callback(new Error('Origin not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type']
  };
}

const objectId = (id, type) => {
  if (!mongoose.isValidObjectId(id)) throw new AppError(`${type} not found`, 404, 'NOT_FOUND');
};
const pagination = (page, limit, total) => ({ page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) });
const statusTimestamp = status => status === 'saved' ? 'savedAt' : status === 'discarded' ? 'notUsefulAt' : null;
function leadFilter(query, { allowJob = true } = {}) {
  const filter = {};
  if (query.status) filter.status = assertLeadStatus(query.status);
  if (allowJob && query.searchJobId) { objectId(query.searchJobId, 'Search job'); filter.searchJobId = query.searchJobId; }
  const timestamp = statusTimestamp(filter.status);
  if ((query.from || query.to) && !timestamp) throw new AppError('Date filters require Saved or Not Useful status', 400, 'VALIDATION_ERROR');
  if (timestamp) applyDateRange(filter, parseDateRange(query, timestamp));
  if (query.search?.trim()) { const term = query.search.trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); filter.$or = [{ businessName: { $regex: term, $options: 'i' } }, { domain: { $regex: term, $options: 'i' } }, { email: { $regex: term, $options: 'i' } }]; }
  return filter;
}
const csvCell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
function csvRow(lead, srNo) { return [srNo, lead.businessName, lead.website, lead.phone, lead.email, lead.address || '', lead.location || '', '', '', lead.status, lead.discoveredAt?.toISOString() || '', lead.savedAt?.toISOString() || '', lead.notUsefulAt?.toISOString() || ''].map(csvCell).join(','); }

app.disable('x-powered-by');
app.use(async (_req, _res, next) => {
  try {
    await connectDatabase();
    next();
  } catch (error) {
    next(error);
  }
});
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use((req, res, next) => cors(corsOptionsForRequest(req))(req, res, next));
app.use(express.json({ limit: '20kb', type: 'application/json' }));

app.post('/api/discovery/jobs', discoveryRateLimit, async (req, res) => {
  const unresolved = await Lead.exists({ status: 'new' });
  const active = await SearchJob.findOne({ status: { $in: ['queued', 'running'] } }).sort({ createdAt: -1 }).lean();
  if (active || unresolved) throw new AppError(active ? 'A discovery job is already in progress' : 'Process or clear every new lead before starting another search', 409, 'UNRESOLVED_LEADS');
  try {
    const job = await SearchJob.create(parseDiscoveryInput(req.body));
    res.status(202).json({ jobId: job.id, status: job.status });
  } catch (error) {
    if (error?.code === 11000) throw new AppError('A discovery job is already in progress', 409, 'ACTIVE_JOB_EXISTS');
    throw error;
  }
});
app.get('/api/discovery/current', async (_req, res) => {
  const active = await SearchJob.findOne({ status: { $in: ['queued', 'running'] } }).sort({ createdAt: -1 }).lean();
  const job = active || await SearchJob.findOne({ _id: { $in: await Lead.distinct('searchJobId', { status: 'new', searchJobId: { $ne: null } }) } }).sort({ createdAt: -1 }).lean();
  if (!job) return res.json({ job: null, unresolvedCount: 0 });
  const unresolvedCount = await Lead.countDocuments({ searchJobId: job._id, status: 'new' });
  res.json({ job: { jobId: String(job._id), status: job.status, requested: job.requestedCount, found: job.foundCount, duplicates: job.duplicateCount, rejected: job.rejectedCount, error: job.errorMessage, checkpoint: job.checkpoint }, unresolvedCount });
});
app.get('/api/discovery/jobs/:id', async (req, res) => {
  objectId(req.params.id, 'Job');
  // Polling is also the durable job runner. This avoids relying on waitUntil or an
  // in-memory process surviving a Vercel/serverless invocation.
  await runDiscovery(req.params.id);
  const job = await SearchJob.findById(req.params.id).lean();
  if (!job) throw new AppError('Job not found', 404, 'NOT_FOUND');
  res.json({ jobId: String(job._id), status: job.status, requested: job.requestedCount, found: job.foundCount, duplicates: job.duplicateCount, rejected: job.rejectedCount, error: job.errorMessage, checkpoint: job.checkpoint, createdAt: job.createdAt, completedAt: job.completedAt });
});
app.post('/api/discovery/jobs/:id/cancel', async (req, res) => {
  objectId(req.params.id, 'Job');
  const job = await SearchJob.findOneAndUpdate({ _id: req.params.id, status: { $in: ['queued', 'running'] } }, { $set: { status: 'cancelled', completedAt: new Date(), workerToken: null, workerLeaseExpiresAt: null } }, { new: true });
  if (!job) throw new AppError('Job cannot be cancelled', 409, 'JOB_NOT_CANCELLABLE');
  // Cancelled discovery is not an unresolved result set. Clearing its new rows
  // also means cancellation cannot hold the one-job lock after a refresh.
  await Lead.deleteMany({ searchJobId: job._id, status: 'new' });
  res.json({ jobId: job.id, status: job.status, requested: job.requestedCount, found: job.foundCount, duplicates: job.duplicateCount, rejected: job.rejectedCount, completedAt: job.completedAt });
});
app.get('/api/leads', async (req, res) => {
  const { page, limit } = parsePagination(req.query); const filter = leadFilter(req.query);
  const sort = req.query.status === 'saved' ? { savedAt: -1, _id: -1 } : req.query.status === 'discarded' ? { notUsefulAt: -1, _id: -1 } : { discoveredAt: -1, _id: -1 };
  const [items, total] = await Promise.all([Lead.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(), Lead.countDocuments(filter)]);
  res.json({ items: items.map((item, index) => ({ ...item, srNo: (page - 1) * limit + index + 1 })), pagination: pagination(page, limit, total) });
});
app.get('/api/leads/export', async (req, res) => {
  const filter = leadFilter(req.query);
  const sort = req.query.status === 'saved' ? { savedAt: -1, _id: -1 } : req.query.status === 'discarded' ? { notUsefulAt: -1, _id: -1 } : { discoveredAt: -1, _id: -1 };
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
  res.write('﻿Sr. No.,Business Name,Website,Phone,Email,Address,City,State,Pincode,Status,Search Date,Saved Date,Not Useful Date\n');
  let srNo = 0; const cursor = Lead.find(filter).sort(sort).lean().cursor();
  for await (const lead of cursor) { srNo += 1; if (!res.write(`${csvRow(lead, srNo)}\n`)) await new Promise(resolve => res.once('drain', resolve)); }
  res.end();
});
app.get('/api/leads/:id', async (req, res) => {
  objectId(req.params.id, 'Lead');
  const lead = await Lead.findById(req.params.id).lean();
  if (!lead) throw new AppError('Lead not found', 404, 'NOT_FOUND');
  res.json(lead);
});
app.patch('/api/leads/:id/status', async (req, res) => {
  objectId(req.params.id, 'Lead'); const status = assertLeadStatus(req.body?.status);
  const timestamp = statusTimestamp(status); const update = { $set: { status, savedAt: timestamp === 'savedAt' ? new Date() : null, notUsefulAt: timestamp === 'notUsefulAt' ? new Date() : null } };
  const lead = await Lead.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true }).lean();
  if (!lead) throw new AppError('Lead not found', 404, 'NOT_FOUND'); res.json(lead);
});
app.delete('/api/leads/:id', async (req, res) => {
  objectId(req.params.id, 'Lead'); const lead = await Lead.findOneAndDelete({ _id: req.params.id, status: 'new' }).lean();
  if (!lead) throw new AppError('Only unresolved leads can be cleared', 409, 'LEAD_NOT_CLEARABLE'); res.json({ deletedId: String(lead._id) });
});
app.post('/api/leads/bulk', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids)] : []; const action = req.body?.action;
  if (!ids.length || ids.length > 100 || !ids.every(mongoose.isValidObjectId)) throw new AppError('Choose one to 100 valid leads', 400, 'VALIDATION_ERROR');
  if (!['saved', 'discarded', 'delete'].includes(action)) throw new AppError('Unsupported bulk action', 400, 'VALIDATION_ERROR');
  const filter = { _id: { $in: ids }, status: 'new' };
  const timestamp = statusTimestamp(action); const result = action === 'delete' ? await Lead.deleteMany(filter) : await Lead.updateMany(filter, { $set: { status: action, savedAt: timestamp === 'savedAt' ? new Date() : null, notUsefulAt: timestamp === 'notUsefulAt' ? new Date() : null } }, { runValidators: true });
  const changed = result.deletedCount ?? result.modifiedCount;
  if (!changed) throw new AppError('The selected unresolved leads are no longer available', 409, 'LEADS_NOT_ACTIONABLE');
  res.json({ changed });
});
app.post('/api/settings/lead-deletion/count', async (req, res) => {
  const { status = 'all', scope = 'all', from, to, searchJobId } = req.body || {};
  if (!['all', 'new', 'saved', 'discarded'].includes(status) || !['all', 'custom'].includes(scope)) throw new AppError('Invalid deletion filter', 400, 'VALIDATION_ERROR');
  const filter = status === 'all' ? {} : { status };
  if (searchJobId) { objectId(searchJobId, 'Search job'); filter.searchJobId = searchJobId; }
  if (scope === 'custom') applyDateRange(filter, parseDateRange({ from, to }, 'discoveredAt'));
  res.json({ count: await Lead.countDocuments(filter) });
});
app.post('/api/settings/lead-deletion', async (req, res) => {
  if (req.body?.confirmation !== 'DELETE') throw new AppError('Type DELETE to permanently delete matching leads', 400, 'CONFIRMATION_REQUIRED');
  const { status = 'all', scope = 'all', from, to, searchJobId } = req.body || {};
  if (!['all', 'new', 'saved', 'discarded'].includes(status) || !['all', 'custom'].includes(scope)) throw new AppError('Invalid deletion filter', 400, 'VALIDATION_ERROR');
  const filter = status === 'all' ? {} : { status }; if (searchJobId) { objectId(searchJobId, 'Search job'); filter.searchJobId = searchJobId; }
  if (scope === 'custom') applyDateRange(filter, parseDateRange({ from, to }, 'discoveredAt'));
  const result = await Lead.deleteMany(filter); res.json({ deleted: result.deletedCount });
});
app.get('/api/search-history', async (req, res) => {
  const { page, limit } = parsePagination(req.query);
  const [items, total] = await Promise.all([SearchHistory.find({}).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), SearchHistory.countDocuments()]);
  res.json({ items, pagination: pagination(page, limit, total) });
});
app.get('/api/health', (_req, res) => {
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({ status: connected ? 'ok' : 'degraded', database: connected ? 'connected' : 'disconnected' });
});

app.use(express.static(publicDirectory, { index: 'index.html', maxAge: env.nodeEnv === 'production' ? '1h' : 0 }));
app.use((_req, _res, next) => next(Object.assign(new Error('Route not found'), { status: 404 })));
app.use((error, _req, res, _next) => {
  if (error?.code === 11000) return res.status(409).json({ error: 'This business is already saved or marked not useful.', code: 'DUPLICATE_RESOLVED_LEAD' });
  const status = error.status || 500;
  if (status >= 500) logger.error(error.message, error.stack);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong. Please try again.' : error.message, code: error.code || 'INTERNAL_ERROR' });
});

async function startServer() {
  try {
    await connectDatabase();
    app.listen(env.port, () => logger.info(`Server listening on port ${env.port}`));
  } catch {
    logger.error('Startup failed: database connection is unavailable.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer();

export default app;
