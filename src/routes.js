import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { waitUntil } from '@vercel/functions';
import { env } from './config.js';
import { Lead, SearchHistory, SearchJob } from './models.js';
import { runDiscovery } from './services.js';
import { AppError, assertLeadStatus, parseDiscoveryInput, parsePagination } from './utils.js';

const router = Router();
const discoveryRateLimit = rateLimit({ windowMs: env.rateLimitWindowMs, limit: env.rateLimitMax, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many discovery requests. Please try again later.' } });
const objectId = (id, type) => { if (!mongoose.isValidObjectId(id)) throw new AppError(`${type} not found`, 404, 'NOT_FOUND'); };
const pagination = (page, limit, total) => ({ page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) });

router.post('/discovery/jobs', discoveryRateLimit, async (req, res) => {
  const job = await SearchJob.create(parseDiscoveryInput(req.body));
  res.status(202).json({ jobId: job.id, status: job.status });
  waitUntil(runDiscovery(job.id));
});
router.get('/discovery/jobs/:id', async (req, res) => {
  objectId(req.params.id, 'Job'); const job = await SearchJob.findById(req.params.id).lean();
  if (!job) throw new AppError('Job not found', 404, 'NOT_FOUND');
  res.json({ jobId: String(job._id), status: job.status, requested: job.requestedCount, found: job.foundCount, duplicates: job.duplicateCount, rejected: job.rejectedCount, error: job.errorMessage, createdAt: job.createdAt, completedAt: job.completedAt });
});
router.post('/discovery/jobs/:id/cancel', async (req, res) => {
  objectId(req.params.id, 'Job'); const job = await SearchJob.findOneAndUpdate({ _id: req.params.id, status: { $in: ['queued', 'running'] } }, { $set: { status: 'cancelled', completedAt: new Date() } }, { new: true });
  if (!job) throw new AppError('Job cannot be cancelled', 409, 'JOB_NOT_CANCELLABLE'); res.json({ jobId: job.id, status: job.status });
});
router.get('/leads', async (req, res) => {
  const { page, limit } = parsePagination(req.query), filter = {};
  if (req.query.status) filter.status = assertLeadStatus(req.query.status);
  if (req.query.search?.trim()) { const term = req.query.search.trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); filter.$or = [{ businessName: { $regex: term, $options: 'i' } }, { domain: { $regex: term, $options: 'i' } }, { email: { $regex: term, $options: 'i' } }]; }
  const [items, total] = await Promise.all([Lead.find(filter).sort({ discoveredAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), Lead.countDocuments(filter)]);
  res.json({ items, pagination: pagination(page, limit, total) });
});
router.get('/leads/:id', async (req, res) => { objectId(req.params.id, 'Lead'); const lead = await Lead.findById(req.params.id).lean(); if (!lead) throw new AppError('Lead not found', 404, 'NOT_FOUND'); res.json(lead); });
router.patch('/leads/:id/status', async (req, res) => { objectId(req.params.id, 'Lead'); const lead = await Lead.findByIdAndUpdate(req.params.id, { $set: { status: assertLeadStatus(req.body.status) } }, { new: true, runValidators: true }).lean(); if (!lead) throw new AppError('Lead not found', 404, 'NOT_FOUND'); res.json(lead); });
router.get('/search-history', async (req, res) => { const { page, limit } = parsePagination(req.query); const [items, total] = await Promise.all([SearchHistory.find({}).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), SearchHistory.countDocuments()]); res.json({ items, pagination: pagination(page, limit, total) }); });
router.get('/health', (_req, res) => res.status(mongoose.connection.readyState === 1 ? 200 : 503).json({ status: mongoose.connection.readyState === 1 ? 'ok' : 'degraded', database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' }));
export default router;
