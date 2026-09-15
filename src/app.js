import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import { authRoutes, isAuthenticated, requireAuth, requireDashboardAuth } from './auth.js';
import { connectDatabase, env, Lead, SearchHistory, SearchJob, OutreachTemplate, Campaign, CampaignRecipient, OutreachActivity } from './models.js';
import { sendEmailBatch } from './services/email.js';
import { runDiscovery } from './services.js';
import { AppError, applyDateRange, assertLeadStatus, isSafePublicUrl, isValidPublicEmail, logger, normalizeDomain, normalizeEmail, normalizePhone, normalizeUrl, parseDateRange, parseDiscoveryInput, parsePagination } from './utils.js';

const app = express();
const publicDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public');
const allowedOrigins = env.appOrigin.split(',').map((origin) => origin.trim()).filter(Boolean);
const sendRateLimit = rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many send requests. Please wait before trying again.' } });
const discoveryRateLimit = rateLimit({ windowMs: env.rateLimitWindowMs, limit: env.rateLimitMax, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many discovery requests. Please try again later.' } });
const loginRateLimit = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many login attempts. Please try again later.', code: 'LOGIN_RATE_LIMITED' } });

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
const deletionDateField = status => statusTimestamp(status) || 'discoveredAt';
export function leadDeletionFilter({ status = 'all', scope = 'all', from, to } = {}) {
  if (!['all', 'new', 'saved', 'discarded'].includes(status) || !['all', 'custom'].includes(scope)) {
    throw new AppError('Invalid deletion filter', 400, 'VALIDATION_ERROR');
  }

  const filter = status === 'all' ? {} : { status };
  // A lifecycle date is the meaningful date for resolved leads. New and mixed
  // selections remain anchored to the original discovery date.
  if (scope === 'custom') applyDateRange(filter, parseDateRange({ from, to }, deletionDateField(status)));
  return filter;
}
export async function leadDeletionPreview(leadModel, payload) {
  const filter = leadDeletionFilter(payload);
  const statuses = ['new', 'saved', 'discarded'];
  const [count, ...counts] = await Promise.all([
    leadModel.countDocuments(filter),
    ...statuses.map(status => leadModel.countDocuments({ ...filter, status }))
  ]);
  return { count, breakdown: { total: count, new: counts[0], saved: counts[1], discarded: counts[2] } };
}
export async function deleteMatchingLeads(leadModel, payload) {
  if (payload?.confirmation !== 'DELETE') throw new AppError('Type DELETE to permanently delete matching leads', 400, 'CONFIRMATION_REQUIRED');
  const filter = leadDeletionFilter(payload);
  const result = await leadModel.deleteMany(filter);
  return result.deletedCount;
}
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
function manualLeadInput(body) {
  const businessName = cleanText(body?.businessName, 'Business name', 200);
  const website = normalizeUrl(body?.website); const domain = normalizeDomain(website);
  if (!website || !domain || !isSafePublicUrl(website)) throw new AppError('Website must be a valid public URL', 400, 'VALIDATION_ERROR');
  const rawEmail = typeof body?.email === 'string' ? body.email.trim() : '';
  const email = rawEmail ? normalizeEmail(rawEmail) : null;
  if (email && !isValidPublicEmail(email)) throw new AppError('Email must be a valid business email', 400, 'VALIDATION_ERROR');
  const rawPhone = typeof body?.phone === 'string' ? body.phone.trim() : '';
  const phone = rawPhone ? normalizePhone(rawPhone) : null;
  if (rawPhone && !phone) throw new AppError('Phone must be a valid phone number', 400, 'VALIDATION_ERROR');
  if (!email && !phone) throw new AppError('Add an email address or phone number', 400, 'VALIDATION_ERROR');
  return { businessName, website, domain, email, phone, category: cleanText(body?.category, 'Category', 100), location: cleanText(body?.location, 'Location', 100), notes: cleanText(body?.notes, 'Notes', 2000, false) || '', status: 'saved', savedAt: new Date(), searchJobId: null, discoverySource: 'manual', isEcommerce: true };
}
export function managementPipeline(query) {
  const base = leadFilter({ ...query, status: 'saved' }, { allowJob: false });
  const latestActivity = channel => ({ $lookup: { from: 'outreachactivities', let: { leadId: '$_id' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$leadId', '$$leadId'] }, { $eq: ['$channel', channel] }] } } }, { $addFields: { activityAt: { $ifNull: ['$sentAt', '$createdAt'] } } }, { $sort: { activityAt: -1, createdAt: -1, _id: -1 } }, { $limit: 1 }], as: `${channel}Activities` } });
  const pipeline = [{ $match: base }, { $lookup: { from: 'campaignrecipients', localField: '_id', foreignField: 'leadId', as: 'recipients' } }, latestActivity('email'), latestActivity('whatsapp'), { $lookup: { from: 'outreachactivities', localField: '_id', foreignField: 'leadId', as: 'activities' } }, { $lookup: { from: 'campaigns', localField: 'recipients.campaignId', foreignField: '_id', as: 'campaigns' } }];
  pipeline.push({ $addFields: {
    emailActivity: { $arrayElemAt: ['$emailActivities', 0] }, whatsappActivity: { $arrayElemAt: ['$whatsappActivities', 0] },
    emailActiveRecipient: { $gt: [{ $size: { $filter: { input: '$recipients', as: 'r', cond: { $and: [{ $eq: ['$$r.channel', 'email'] }, { $in: ['$$r.status', ['pending', 'ready', 'sending']] }] } } } }, 0] },
    whatsappActiveRecipient: { $gt: [{ $size: { $filter: { input: '$recipients', as: 'r', cond: { $and: [{ $eq: ['$$r.channel', 'whatsapp'] }, { $in: ['$$r.status', ['pending', 'ready', 'sending']] }] } } } }, 0] },
    lastContacted: { $max: { $map: { input: { $filter: { input: '$activities', as: 'a', cond: { $in: ['$$a.status', ['sent', 'manual_sent']] } } }, as: 'a', in: { $ifNull: ['$$a.sentAt', '$$a.createdAt'] } } } }
  } });
  pipeline.push({ $addFields: {
    emailStatus: { $switch: { branches: [{ case: { $in: ['$emailActivity.status', ['sent', 'manual_sent']] }, then: 'sent' }, { case: { $eq: ['$emailActivity.status', 'failed'] }, then: 'failed' }], default: 'not_sent' } },
    whatsappStatus: { $switch: { branches: [{ case: { $in: ['$whatsappActivity.status', ['sent', 'manual_sent']] }, then: 'sent' }, { case: { $eq: ['$whatsappActivity.status', 'failed'] }, then: 'failed' }], default: 'not_sent' } }
  } });
  const tab = query.tab || 'all'; if (!['all', 'uncontacted', 'email', 'whatsapp', 'contacted'].includes(tab)) throw new AppError('Invalid lead management tab', 400, 'VALIDATION_ERROR');
  const conditions = []; if (tab === 'email') conditions.push({ email: { $ne: null } }); if (tab === 'whatsapp') conditions.push({ phone: { $ne: null } }); if (tab === 'contacted') conditions.push({ lastContacted: { $ne: null } }); if (tab === 'uncontacted') conditions.push({ lastContacted: null });
  if (query.channel === 'email') conditions.push({ email: { $ne: null } }); else if (query.channel === 'whatsapp') conditions.push({ phone: { $ne: null } }); else if (query.channel && query.channel !== 'all') throw new AppError('Invalid channel filter', 400, 'VALIDATION_ERROR');
  const communicationStatus = query.communicationStatus; if (communicationStatus && communicationStatus !== 'all') { if (!['sent', 'failed', 'pending', 'skipped', 'not_sent'].includes(communicationStatus)) throw new AppError('Invalid communication status', 400, 'VALIDATION_ERROR'); const statusField = channel => communicationStatus === 'pending' ? `${channel}ActiveRecipient` : communicationStatus === 'skipped' ? `${channel}Activity.status` : `${channel}Status`; const statusCondition = channel => ({ [statusField(channel)]: communicationStatus === 'pending' ? true : communicationStatus === 'skipped' ? 'skipped' : communicationStatus }); if (query.channel === 'email' || query.channel === 'whatsapp') conditions.push(statusCondition(query.channel)); else conditions.push({ $or: ['email', 'whatsapp'].map(statusCondition) }); }
  if (query.campaign) { objectId(query.campaign, 'Campaign'); conditions.push({ 'recipients.campaignId': new mongoose.Types.ObjectId(query.campaign) }); }
  if (conditions.length) pipeline.push({ $match: conditions.length === 1 ? conditions[0] : { $and: conditions } });
  return pipeline;
}

const csvCell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
function csvRow(lead, srNo) { return [srNo, lead.businessName, lead.website, lead.phone, lead.email, lead.address || '', lead.location || '', '', '', lead.status, lead.discoveredAt?.toISOString() || '', lead.savedAt?.toISOString() || '', lead.notUsefulAt?.toISOString() || ''].map(csvCell).join(','); }

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use((req, res, next) => cors(corsOptionsForRequest(req))(req, res, next));
app.use(express.json({ limit: '20kb', type: 'application/json' }));
authRoutes(app, loginRateLimit);
app.get('/api/health', (_req, res) => {
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({ status: connected ? 'ok' : 'degraded', database: connected ? 'connected' : 'disconnected' });
});
app.use('/api', requireAuth);
app.use('/api', async (_req, _res, next) => {
  try {
    await connectDatabase();
    next();
  } catch (error) {
    next(error);
  }
});

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
  const { page, limit } = parsePagination(req.query);
  if (req.query.status === 'saved') {
    const managementLimit = Math.min(limit, 20);
    const pipeline = managementPipeline(req.query);
    const [result] = await Lead.aggregate([...pipeline, { $sort: { savedAt: -1, _id: -1 } }, { $facet: { items: [{ $skip: (page - 1) * managementLimit }, { $limit: managementLimit }], total: [{ $count: 'count' }] } }]);
    const total = result?.total?.[0]?.count || 0;
    return res.json({ items: (result?.items || []).map((item, index) => ({ ...item, srNo: (page - 1) * managementLimit + index + 1 })), pagination: pagination(page, managementLimit, total) });
  }
  const filter = leadFilter(req.query); const sort = req.query.status === 'discarded' ? { notUsefulAt: -1, _id: -1 } : { discoveredAt: -1, _id: -1 };
  const [items, total] = await Promise.all([Lead.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(), Lead.countDocuments(filter)]);
  res.json({ items: items.map((item, index) => ({ ...item, srNo: (page - 1) * limit + index + 1 })), pagination: pagination(page, limit, total) });
});
app.get('/api/leads/export', async (req, res) => {
  const isManagement = req.query.status === 'saved'; const filter = isManagement ? null : leadFilter(req.query);
  const sort = req.query.status === 'discarded' ? { notUsefulAt: -1, _id: -1 } : { discoveredAt: -1, _id: -1 };
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
  res.write('﻿Sr. No.,Business Name,Website,Phone,Email,Address,City,State,Pincode,Status,Search Date,Saved Date,Not Useful Date\n');
  let srNo = 0; const cursor = isManagement ? Lead.aggregate([...managementPipeline(req.query), { $sort: { savedAt: -1, _id: -1 } }]).cursor({ batchSize: 100 }) : Lead.find(filter).sort(sort).lean().cursor();
  for await (const lead of cursor) { srNo += 1; if (!res.write(`${csvRow(lead, srNo)}\n`)) await new Promise(resolve => res.once('drain', resolve)); }
  res.end();
});
app.post('/api/leads/manual', async (req, res) => {
  const lead = await Lead.create(manualLeadInput(req.body));
  res.status(201).json(lead);
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
  res.json(await leadDeletionPreview(Lead, req.body));
});
app.post('/api/settings/lead-deletion', async (req, res) => {
  const deleted = await deleteMatchingLeads(Lead, req.body);
  res.json({ deleted });
});
app.get('/api/search-history', async (req, res) => {
  const { page, limit } = parsePagination(req.query);
  const [items, total] = await Promise.all([SearchHistory.find({}).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), SearchHistory.countDocuments()]);
  res.json({ items, pagination: pagination(page, limit, total) });
});
const templateVariables = new Set(['business_name', 'website', 'email', 'phone', 'domain']);
function cleanText(value, label, max, required = true) { if (typeof value !== 'string') { if (required) throw new AppError(`${label} is required`, 400, 'VALIDATION_ERROR'); return null; } const text = value.trim(); if (required && !text) throw new AppError(`${label} is required`, 400, 'VALIDATION_ERROR'); if (text.length > max) throw new AppError(`${label} must be ${max} characters or fewer`, 400, 'VALIDATION_ERROR'); if (/<\s*script|javascript\s*:/i.test(text)) throw new AppError(`${label} contains unsafe content`, 400, 'VALIDATION_ERROR'); return text; }
function templateInput(body) { const type = body?.type; if (!['email', 'whatsapp'].includes(type)) throw new AppError('Template type must be email or whatsapp', 400, 'VALIDATION_ERROR'); const subject = type === 'email' ? cleanText(body.subject, 'Subject', 200) : null; return { name: cleanText(body.name, 'Template name', 120), type, subject, body: cleanText(body.body ?? body.message, 'Message', 10000) }; }
function renderTemplate(text, lead) { const values = { business_name: lead.businessName, website: lead.website, email: lead.email, phone: lead.phone || '', domain: lead.domain }; return text.replace(/{{\s*([a-z_]+)\s*}}/gi, (_match, key) => templateVariables.has(key.toLowerCase()) ? String(values[key.toLowerCase()] ?? '') : ''); }
async function updateCampaignCounts(campaignId) {
  const rows = await CampaignRecipient.aggregate([{ $match: { campaignId: new mongoose.Types.ObjectId(campaignId) } }, { $group: {
    _id: null, total: { $sum: 1 }, businesses: { $addToSet: '$leadId' },
    email: { $sum: { $cond: [{ $eq: ['$channel', 'email'] }, 1, 0] } }, whatsapp: { $sum: { $cond: [{ $eq: ['$channel', 'whatsapp'] }, 1, 0] } },
    emailSent: { $sum: { $cond: [{ $and: [{ $eq: ['$channel', 'email'] }, { $eq: ['$status', 'sent'] }] }, 1, 0] } },
    emailFailed: { $sum: { $cond: [{ $and: [{ $eq: ['$channel', 'email'] }, { $eq: ['$status', 'failed'] }] }, 1, 0] } },
    emailPending: { $sum: { $cond: [{ $and: [{ $eq: ['$channel', 'email'] }, { $in: ['$status', ['pending', 'ready', 'sending']] }] }, 1, 0] } },
    whatsappSent: { $sum: { $cond: [{ $and: [{ $eq: ['$channel', 'whatsapp'] }, { $eq: ['$status', 'manual_sent'] }] }, 1, 0] } },
    whatsappPending: { $sum: { $cond: [{ $and: [{ $eq: ['$channel', 'whatsapp'] }, { $in: ['$status', ['pending', 'ready']] }] }, 1, 0] } },
    whatsappSkipped: { $sum: { $cond: [{ $and: [{ $eq: ['$channel', 'whatsapp'] }, { $eq: ['$status', 'skipped'] }] }, 1, 0] } }
  } }]);
  const c = rows[0] || { total: 0, businesses: [], email: 0, whatsapp: 0, emailSent: 0, emailFailed: 0, emailPending: 0, whatsappSent: 0, whatsappPending: 0, whatsappSkipped: 0 };
  const processed = c.emailSent + c.emailFailed;
  await Campaign.findByIdAndUpdate(campaignId, { $set: { recipientCount: c.total, businessCount: c.businesses.length, emailCount: c.email, whatsappCount: c.whatsapp, emailSentCount: c.emailSent, emailFailedCount: c.emailFailed, emailPendingCount: c.emailPending, whatsappSentCount: c.whatsappSent, whatsappPendingCount: c.whatsappPending, whatsappSkippedCount: c.whatsappSkipped, sentCount: c.emailSent + c.whatsappSent, failedCount: c.emailFailed, pendingCount: c.emailPending, processedCount: processed } });
  return { ...c, businessCount: c.businesses.length, processed };
}
async function requireCampaign(id) { objectId(id, 'Campaign'); const campaign = await Campaign.findById(id).lean(); if (!campaign) throw new AppError('Campaign not found', 404, 'NOT_FOUND'); return campaign; }
export async function deleteCampaign(campaignModel, recipientModel, id) {
  objectId(id, 'Campaign');
  const campaign = await campaignModel.findById(id).lean();
  if (!campaign) throw new AppError('Campaign not found', 404, 'NOT_FOUND');
  if (campaign.status === 'sending') throw new AppError('Campaign cannot be deleted while it is sending.', 409, 'CAMPAIGN_SENDING');
  // The conditional delete is the final state check, preventing a send that
  // started after the initial read from being removed as a completed campaign.
  const deleted = await campaignModel.findOneAndDelete({ _id: id, status: { $ne: 'sending' } }).lean();
  if (!deleted) throw new AppError('Campaign cannot be deleted while it is sending.', 409, 'CAMPAIGN_SENDING');
  await recipientModel.deleteMany({ campaignId: deleted._id });
  // OutreachActivity is intentionally not touched: it is permanent lead history.
  return deleted;
}
async function recipientFor(campaignId, recipientId) { objectId(recipientId, 'Campaign recipient'); const recipient = await CampaignRecipient.findOne({ _id: recipientId, campaignId }).lean(); if (!recipient) throw new AppError('Campaign recipient not found', 404, 'NOT_FOUND'); return recipient; }
app.get('/api/templates', async (_req, res) => res.json({ items: await OutreachTemplate.find({}).sort({ updatedAt: -1 }).lean() }));
app.post('/api/templates', async (req, res) => res.status(201).json(await OutreachTemplate.create(templateInput(req.body))));
app.get('/api/templates/:id', async (req, res) => { objectId(req.params.id, 'Template'); const item = await OutreachTemplate.findById(req.params.id).lean(); if (!item) throw new AppError('Template not found', 404, 'NOT_FOUND'); res.json(item); });
app.patch('/api/templates/:id', async (req, res) => { objectId(req.params.id, 'Template'); const item = await OutreachTemplate.findByIdAndUpdate(req.params.id, templateInput(req.body), { new: true, runValidators: true }).lean(); if (!item) throw new AppError('Template not found', 404, 'NOT_FOUND'); res.json(item); });
app.delete('/api/templates/:id', async (req, res) => { objectId(req.params.id, 'Template'); if (await CampaignRecipient.exists({ templateId: req.params.id })) throw new AppError('A template used by campaign recipients cannot be deleted', 409, 'TEMPLATE_IN_USE'); const item = await OutreachTemplate.findByIdAndDelete(req.params.id).lean(); if (!item) throw new AppError('Template not found', 404, 'NOT_FOUND'); res.json({ deletedId: req.params.id }); });
app.get('/api/campaigns', async (_req, res) => res.json({ items: await Campaign.find({}).sort({ updatedAt: -1 }).lean() }));
app.post('/api/campaigns', async (req, res) => { const channels = [...new Set(req.body?.channels || [])]; if (!channels.length || !channels.every(channel => ['email', 'whatsapp'].includes(channel))) throw new AppError('Choose at least one campaign channel', 400, 'VALIDATION_ERROR'); const payload = { name: cleanText(req.body?.name, 'Campaign name', 120), channels, status: 'draft', emailTemplateId: null, whatsappTemplateId: null }; for (const channel of channels) { const key = channel === 'email' ? 'emailTemplateId' : 'whatsappTemplateId'; if (!mongoose.isValidObjectId(req.body?.[key])) throw new AppError(`A valid ${channel} template is required`, 400, 'VALIDATION_ERROR'); const template = await OutreachTemplate.findOne({ _id: req.body[key], type: channel }).lean(); if (!template) throw new AppError(`Selected ${channel} template was not found`, 400, 'VALIDATION_ERROR'); payload[key] = template._id; } res.status(201).json(await Campaign.create(payload)); });
app.get('/api/campaigns/:id', async (req, res) => res.json(await requireCampaign(req.params.id)));
app.patch('/api/campaigns/:id', async (req, res) => { const campaign = await requireCampaign(req.params.id); if (!['draft', 'ready', 'paused'].includes(campaign.status)) throw new AppError('Only draft, ready, or paused campaigns can be changed', 409, 'CAMPAIGN_LOCKED'); const name = req.body?.name === undefined ? campaign.name : cleanText(req.body.name, 'Campaign name', 120); const status = req.body?.status === undefined ? campaign.status : req.body.status; if (!['draft', 'ready', 'paused'].includes(status)) throw new AppError('Invalid campaign status', 400, 'VALIDATION_ERROR'); res.json(await Campaign.findByIdAndUpdate(campaign._id, { $set: { name, status } }, { new: true }).lean()); });
app.delete('/api/campaigns/:id', async (req, res) => {
  const campaign = await deleteCampaign(Campaign, CampaignRecipient, req.params.id);
  res.json({ deletedId: String(campaign._id) });
});
function selectedLeadPipeline(body) {
  if (body?.selectAllMatching === true) return managementPipeline({ status: 'saved', search: body.search, from: body.from, to: body.to, tab: body.tab, channel: body.channel, communicationStatus: body.communicationStatus, campaign: body.campaign });
  const ids = Array.isArray(body?.leadIds) ? [...new Set(body.leadIds)] : [];
  if (!ids.length || ids.length > 100 || !ids.every(mongoose.isValidObjectId)) throw new AppError('Choose one to 100 valid saved leads', 400, 'VALIDATION_ERROR');
  return [{ $match: { _id: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) }, status: 'saved' } }];
}
app.post('/api/campaigns/:id/recipients', async (req, res) => {
  const campaign = await requireCampaign(req.params.id); if (!['draft', 'ready', 'paused'].includes(campaign.status)) throw new AppError('Campaign cannot accept recipients while sending or completed', 409, 'CAMPAIGN_LOCKED');
  let created = 0; let seen = 0; let batch = [];
  const saveBatch = async leads => {
    if (!leads.length) return; seen += leads.length;
    const activities = await OutreachActivity.find({ leadId: { $in: leads.map(l => l._id) }, status: { $in: ['sent', 'manual_sent'] } }).lean();
    const contacted = new Set(activities.map(activity => `${activity.leadId}:${activity.channel}`));
    const docs = leads.flatMap(lead => campaign.channels.map(channel => ({ lead, channel })).filter(({ lead, channel }) => (channel === 'email' ? lead.email : lead.phone) && (req.body?.includeContacted === true || !contacted.has(`${lead._id}:${channel}`))).map(({ lead, channel }) => ({ campaignId: campaign._id, leadId: lead._id, channel, recipient: channel === 'email' ? lead.email : lead.phone, templateId: channel === 'email' ? campaign.emailTemplateId : campaign.whatsappTemplateId, status: 'ready', idempotencyKey: `campaign:${campaign._id}:lead:${lead._id}:channel:${channel}` })));
    if (docs.length) { const result = await CampaignRecipient.bulkWrite(docs.map(doc => ({ updateOne: { filter: { campaignId: doc.campaignId, leadId: doc.leadId, channel: doc.channel }, update: { $setOnInsert: doc }, upsert: true } }))); created += result.upsertedCount || 0; }
  };
  const cursor = Lead.aggregate(selectedLeadPipeline(req.body)).cursor({ batchSize: 100 });
  for await (const lead of cursor) { batch.push(lead); if (batch.length === 100) { await saveBatch(batch); batch = []; } }
  await saveBatch(batch); if (!seen) throw new AppError('No saved leads match this selection', 409, 'LEADS_NOT_SAVED');
  const counts = await updateCampaignCounts(campaign._id); await Campaign.findByIdAndUpdate(campaign._id, { $set: { status: counts.total ? 'ready' : 'draft' } }); res.status(201).json({ created, counts });
});
app.get('/api/campaigns/:id/recipients', async (req, res) => { const campaign = await requireCampaign(req.params.id); const items = await CampaignRecipient.find({ campaignId: campaign._id }).populate('leadId', 'businessName email phone domain').sort({ createdAt: -1 }).lean(); const grouped = new Map(); for (const item of items) { const key = String(item.leadId?._id || item.leadId); if (!grouped.has(key)) grouped.set(key, { lead: item.leadId, email: null, whatsapp: null, lastContacted: null }); const row = grouped.get(key); row[item.channel] = item; const date = ['sent', 'manual_sent'].includes(item.status) ? item.sentAt : null; if (date && (!row.lastContacted || date > row.lastContacted)) row.lastContacted = date; } res.json({ campaign, items: [...grouped.values()] }); });
async function claimEmailBatch(campaign, retryFailed = false) { const stale = await CampaignRecipient.findOne({ campaignId: campaign._id, channel: 'email', status: 'sending', sendingLeaseExpiresAt: { $lt: new Date() } }).lean(); if (stale?.batchKey) return { claimed: await CampaignRecipient.find({ campaignId: campaign._id, batchKey: stale.batchKey, status: 'sending' }).lean(), batchKey: stale.batchKey, batchNumber: stale.batchNumber || campaign.currentBatch }; const batchKey = `campaign:${campaign._id}:batch:${crypto.randomUUID()}`, batchNumber = (campaign.currentBatch || 0) + 1, claimed = []; for (let i = 0; i < 100; i += 1) { const item = await CampaignRecipient.findOneAndUpdate({ campaignId: campaign._id, channel: 'email', status: { $in: retryFailed ? ['failed'] : ['ready', 'pending'] } }, { $set: { status: 'sending', failureReason: null, batchKey, batchNumber, sendingLeaseExpiresAt: new Date(Date.now() + 10 * 60_000) }, $inc: { attempts: 1 } }, { new: true }).lean(); if (!item) break; claimed.push(item); } if (claimed.length) await Campaign.findByIdAndUpdate(campaign._id, { $set: { status: 'sending', currentBatch: batchNumber, currentBatchSize: claimed.length, currentBatchProcessed: 0, startedAt: campaign.startedAt || new Date(), completedAt: null } }); return { claimed, batchKey, batchNumber }; }
async function recordEmailFailure(recipient, campaign, lead, template, reason, code) {
  const failedAt = new Date();
  await Promise.all([
    CampaignRecipient.updateOne({ _id: recipient._id, status: 'sending' }, { $set: { status: 'failed', failedAt, failureReason: `${code}: ${reason}`.slice(0, 500), sendingLeaseExpiresAt: null } }),
    OutreachActivity.create({ leadId: recipient.leadId, campaignId: campaign._id, channel: 'email', templateId: template?._id || recipient.templateId, recipient: lead?.email || recipient.recipient, subject: template && lead ? renderTemplate(template.subject, lead) : null, status: 'failed', failedAt, failureReason: `${code}: ${reason}`.slice(0, 500) })
  ]);
}
async function processEmailBatch(campaign, retryFailed = false) {
  const { claimed, batchKey, batchNumber } = await claimEmailBatch(campaign, retryFailed);
  if (!claimed.length) return { processed: 0, sent: 0, failed: 0, skipped: 0, pending: campaign.emailPendingCount || 0, failures: {} };
  const leads = new Map((await Lead.find({ _id: { $in: claimed.map(r => r.leadId) }, status: 'saved' }).lean()).map(l => [String(l._id), l]));
  const template = await OutreachTemplate.findOne({ _id: campaign.emailTemplateId, type: 'email' }).lean();
  const invalid = claimed.filter(r => !leads.has(String(r.leadId)) || !template || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(leads.get(String(r.leadId))?.email || ''));
  for (const r of invalid) await recordEmailFailure(r, campaign, leads.get(String(r.leadId)), template, 'Lead, recipient email, or template is unavailable.', 'EMAIL_RECIPIENT_INVALID');
  const valid = claimed.filter(r => !invalid.includes(r)); const failures = {}; let sent = 0; let failed = invalid.length;
  if (invalid.length) failures.EMAIL_RECIPIENT_INVALID = invalid.length;
  try {
    const results = valid.length ? await sendEmailBatch(valid.map(r => { const lead = leads.get(String(r.leadId)); return { to: lead.email, subject: renderTemplate(template.subject, lead), text: renderTemplate(template.body, lead) }; }), batchKey) : [];
    await Promise.all(valid.map(async (r, index) => {
      const result = results[index]; const lead = leads.get(String(r.leadId));
      if (!result?.ok) { failed += 1; failures[result?.code || 'EMAIL_PROVIDER_PARTIAL_FAILURE'] = (failures[result?.code || 'EMAIL_PROVIDER_PARTIAL_FAILURE'] || 0) + 1; return recordEmailFailure(r, campaign, lead, template, result?.reason || 'Provider did not accept this recipient.', result?.code || 'EMAIL_PROVIDER_PARTIAL_FAILURE'); }
      const sentAt = new Date(); sent += 1;
      return Promise.all([CampaignRecipient.updateOne({ _id: r._id, status: 'sending', batchKey }, { $set: { status: 'sent', sentAt, providerMessageId: result.id, sendingLeaseExpiresAt: null } }), OutreachActivity.create({ leadId: r.leadId, campaignId: campaign._id, channel: 'email', templateId: template._id, recipient: lead.email, subject: renderTemplate(template.subject, lead), status: 'sent', sentAt, providerMessageId: result.id })]);
    }));
  } catch (error) {
    const code = error.code || 'EMAIL_PROVIDER_REJECTED'; const reason = error.message || 'Email provider rejected the request.';
    failures[code] = valid.length; failed += valid.length;
    for (const r of valid) await recordEmailFailure(r, campaign, leads.get(String(r.leadId)), template, reason, code);
  }
  const counts = await updateCampaignCounts(campaign._id);
  const status = counts.emailPending ? 'ready' : (counts.emailFailedCount && !counts.emailSentCount ? 'failed' : 'completed');
  await Campaign.findByIdAndUpdate(campaign._id, { $set: { currentBatchProcessed: claimed.length, status, ...(counts.emailPending ? {} : { completedAt: new Date() }) } });
  return { processed: claimed.length, sent, failed, skipped: invalid.length, pending: counts.emailPending, failures, batchNumber, counts };
}
app.post('/api/campaigns/:id/send', sendRateLimit, async (req, res) => { const campaign = await requireCampaign(req.params.id); if (!campaign.channels.includes('email')) throw new AppError('Campaign has no email channel', 409, 'NO_EMAIL_CHANNEL'); const result = await processEmailBatch(campaign); const current = await requireCampaign(req.params.id); res.json({ ...result, campaign: current }); });
app.post('/api/campaigns/:id/retry-failed', sendRateLimit, async (req, res) => { const result = await processEmailBatch(await requireCampaign(req.params.id), true); res.json(result); });
app.post('/api/campaigns/:id/recipients/:recipientId/manual-sent', async (req, res) => { const recipient = await recipientFor(req.params.id, req.params.recipientId); if (recipient.channel !== 'whatsapp') throw new AppError('Only WhatsApp recipients can be marked manually sent', 409, 'VALIDATION_ERROR'); const updated = await CampaignRecipient.findOneAndUpdate({ _id: recipient._id, status: { $in: ['ready', 'pending'] } }, { $set: { status: 'manual_sent', sentAt: new Date() } }, { new: true }).lean(); if (updated) await OutreachActivity.create({ leadId: updated.leadId, campaignId: updated.campaignId, channel: 'whatsapp', templateId: updated.templateId, recipient: updated.recipient, status: 'manual_sent', sentAt: updated.sentAt }); res.json({ recipient: updated || recipient, counts: await updateCampaignCounts(req.params.id) }); });
app.post('/api/campaigns/:id/recipients/:recipientId/skip', async (req, res) => { const recipient = await recipientFor(req.params.id, req.params.recipientId); const updated = await CampaignRecipient.findOneAndUpdate({ _id: recipient._id, status: { $in: ['ready', 'pending'] } }, { $set: { status: 'skipped' } }, { new: true }).lean(); if (updated) await OutreachActivity.create({ leadId: updated.leadId, campaignId: updated.campaignId, channel: updated.channel, templateId: updated.templateId, recipient: updated.recipient, status: 'skipped' }); res.json({ recipient: updated || recipient, counts: await updateCampaignCounts(req.params.id) }); });
app.get('/api/campaigns/:id/recipients/:recipientId/whatsapp-message', async (req, res) => { const recipient = await recipientFor(req.params.id, req.params.recipientId); if (recipient.channel !== 'whatsapp') throw new AppError('Only WhatsApp recipients have a WhatsApp message', 409, 'VALIDATION_ERROR'); const [lead, template] = await Promise.all([Lead.findById(recipient.leadId).lean(), OutreachTemplate.findOne({ _id: recipient.templateId, type: 'whatsapp' }).lean()]); if (!lead || !template) throw new AppError('WhatsApp message is unavailable', 409, 'MESSAGE_UNAVAILABLE'); res.json({ message: renderTemplate(template.body, lead) }); });
app.get('/api/leads/:id/outreach', async (req, res) => { objectId(req.params.id, 'Lead'); const items = await OutreachActivity.find({ leadId: req.params.id }).populate('campaignId', 'name').populate('templateId', 'name').sort({ sentAt: -1, createdAt: -1 }).lean(); res.json({ items: items.map(item => ({ ...item, campaignId: item.campaignId || { _id: item.campaignId, name: 'Deleted campaign' } })) }); });
app.get('/api/campaigns/:id/activity', async (req, res) => { await requireCampaign(req.params.id); res.json({ items: await OutreachActivity.find({ campaignId: req.params.id }).sort({ createdAt: -1 }).lean() }); });
app.get(['/login', '/login.html'], (req, res) => {
  if (isAuthenticated(req)) return res.redirect(302, '/');
  res.set('Cache-Control', 'no-store');
  return res.sendFile(path.join(publicDirectory, 'login.html'));
});
app.get(['/', '/index.html'], requireDashboardAuth, (_req, res) => {
  res.set('Cache-Control', 'no-store, private');
  return res.sendFile(path.join(publicDirectory, 'index.html'));
});
app.use(express.static(publicDirectory, { index: false, maxAge: env.nodeEnv === 'production' ? '1h' : 0 }));
app.use((_req, _res, next) => next(Object.assign(new Error('Route not found'), { status: 404 })));
app.use((error, _req, res, _next) => {
  if (error?.code === 11000) return res.status(409).json({ error: 'This business is already saved or marked not useful.', code: 'DUPLICATE_RESOLVED_LEAD' });
  const status = error.status || 500;
  if (status >= 500) logger.error(error.message, error.stack);
  const safeEmailError = typeof error.code === 'string' && error.code.startsWith('EMAIL_');
  res.status(status).json({ error: status >= 500 && !safeEmailError ? 'Something went wrong. Please try again.' : error.message, code: error.code || 'INTERNAL_ERROR' });
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
