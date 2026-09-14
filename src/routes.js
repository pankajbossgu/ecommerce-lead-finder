import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { waitUntil } from '@vercel/functions';
import { env } from './config.js';
import { DiscoveryState, Lead, SearchHistory, SearchJob } from './models.js';
import { runDiscovery } from './services.js';
import { AppError, assertLeadStatus, assertPermanentLeadStatus, parseDiscoveryInput, parsePagination, uniqueObjectIds } from './utils.js';

const router = Router();
const discoveryRateLimit = rateLimit({ windowMs: env.rateLimitWindowMs, limit: env.rateLimitMax, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many discovery requests. Please try again later.' } });
const objectId = (id, type) => { if (!mongoose.isValidObjectId(id)) throw new AppError(`${type} not found`, 404, 'NOT_FOUND'); };
const pagination = (page, limit, total) => ({ page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) });
const jobPayload = (job, pendingCount = 0) => job && ({ jobId: String(job._id), status: job.status, requested: job.requestedCount, found: job.foundCount, duplicates: job.duplicateCount, rejected: job.rejectedCount, pendingCount, error: job.errorMessage, createdAt: job.createdAt, startedAt: job.startedAt, completedAt: job.completedAt });

async function currentDiscovery({ releaseResolved = false } = {}) {
  let state = await DiscoveryState.findById('current').lean();
  if (!state?.currentJobId) {
    // The singleton is the lock, while Lead records remain the durable review
    // source of truth. Reattach a queue if an older deployment left it orphaned.
    const pending = await Lead.findOne({ status: 'pending' }).sort({ discoveredAt: -1 }).select('searchJobId').lean();
    if (!pending) return { job: null, pendingCount: 0 };
    try {
      await DiscoveryState.findOneAndUpdate({ _id: 'current', currentJobId: null }, { $set: { currentJobId: pending.searchJobId }, $setOnInsert: { _id: 'current' } }, { upsert: true });
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
    state = await DiscoveryState.findById('current').lean();
    if (!state?.currentJobId) return { job: null, pendingCount: 0 };
  }
  const job = await SearchJob.findById(state.currentJobId).lean();
  if (!job) { await DiscoveryState.updateOne({ _id: 'current', currentJobId: state.currentJobId }, { $set: { currentJobId: null } }); return { job: null, pendingCount: 0 }; }
  const pendingCount = await Lead.countDocuments({ status: 'pending', searchJobId: job._id });
  const active = ['queued', 'running'].includes(job.status) || pendingCount > 0;
  if (!active && releaseResolved) await DiscoveryState.updateOne({ _id: 'current', currentJobId: job._id }, { $set: { currentJobId: null } });
  return { job: active ? job : null, pendingCount: active ? pendingCount : 0 };
}
async function requireCurrentJob(id) {
  const current = await currentDiscovery();
  if (!current.job || String(current.job._id) !== String(id)) throw new AppError('This is not the current unresolved search', 409, 'NOT_CURRENT_SEARCH');
  return current;
}
async function releaseIfResolved(jobId) {
  const pendingCount = await Lead.countDocuments({ status: 'pending', searchJobId: jobId });
  const job = await SearchJob.findById(jobId).lean();
  if (job && !['queued', 'running'].includes(job.status) && pendingCount === 0) await DiscoveryState.updateOne({ _id: 'current', currentJobId: jobId }, { $set: { currentJobId: null } });
  return pendingCount;
}

router.post('/discovery/jobs', discoveryRateLimit, async (req, res) => {
  const input = parseDiscoveryInput(req.body);
  const before = await currentDiscovery({ releaseResolved: true });
  if (before.job) throw new AppError(['queued', 'running'].includes(before.job.status) ? 'A discovery search is already in progress.' : `Resolve all pending leads before starting a new search. ${before.pendingCount} leads are waiting for review.`, 409, ['queued', 'running'].includes(before.job.status) ? 'SEARCH_BLOCKED_ACTIVE_JOB' : 'SEARCH_BLOCKED_PENDING_LEADS');
  // Reserve a generated job id before creating the job. This is the atomic gate:
  // concurrent callers cannot both create queued SearchJob documents.
  const jobId = new mongoose.Types.ObjectId();
  let locked;
  try {
    locked = await DiscoveryState.findOneAndUpdate({ _id: 'current', currentJobId: null }, { $set: { currentJobId: jobId, lastJobId: jobId }, $setOnInsert: { _id: 'current' } }, { upsert: true, new: true });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    locked = await DiscoveryState.findOneAndUpdate({ _id: 'current', currentJobId: null }, { $set: { currentJobId: jobId, lastJobId: jobId } }, { new: true });
  }
  if (!locked || String(locked.currentJobId) !== String(jobId)) throw new AppError('A discovery search is already in progress or awaiting review.', 409, 'SEARCH_BLOCKED_ACTIVE_JOB');
  let job;
  try { job = await SearchJob.create({ _id: jobId, ...input }); } catch (error) { await DiscoveryState.updateOne({ _id: 'current', currentJobId: jobId }, { $set: { currentJobId: null } }); throw error; }
  res.status(202).json({ jobId: job.id, status: job.status });
  waitUntil(runDiscovery(job.id));
});
router.get('/discovery/current', async (_req, res) => {
  // Recovery is deliberately read-only: only the job holding the singleton
  // lock, while queued or running, can restore an active client session.
  const state = await DiscoveryState.findById('current').lean();
  const job = state?.currentJobId && await SearchJob.findById(state.currentJobId).lean();
  if (!job || !['queued', 'running'].includes(job.status)) return res.json({ jobId: null, status: null });
  const pendingCount = await Lead.countDocuments({ status: 'pending', searchJobId: job._id });
  return res.json(jobPayload(job, pendingCount));
});
router.get('/discovery/jobs/:id', async (req, res) => { objectId(req.params.id, 'Job'); const job = await SearchJob.findById(req.params.id).lean(); if (!job) throw new AppError('Job not found', 404, 'NOT_FOUND'); const pendingCount = await Lead.countDocuments({ searchJobId: job._id, status: 'pending' }); res.json(jobPayload(job, pendingCount)); });
router.post('/discovery/jobs/:id/cancel', async (req, res) => {
  objectId(req.params.id, 'Job'); await requireCurrentJob(req.params.id);
  const job = await SearchJob.findOneAndUpdate({ _id: req.params.id, status: { $in: ['queued', 'running'] } }, { $set: { status: 'cancelled', completedAt: new Date() } }, { new: true });
  if (!job) throw new AppError('Job cannot be cancelled', 409, 'JOB_NOT_CANCELLABLE');
  await DiscoveryState.updateOne({ _id: 'current' }, { $set: { lastJobId: job._id } });
  const pendingCount = await releaseIfResolved(job._id);
  // A cancelled request may end while Gemini is in flight. Recording this here
  // makes history durable even if the background callback never runs again.
  await SearchHistory.updateOne({ searchJobId: job._id }, { $set: { category: job.category, location: job.location, keywords: job.keywords, requestedCount: job.requestedCount, foundCount: job.foundCount, duplicateCount: job.duplicateCount, rejectedCount: job.rejectedCount, status: 'cancelled' } }, { upsert: true });
  res.json(jobPayload(job, pendingCount));
});
router.delete('/discovery/jobs/:id/pending-leads', async (req, res) => {
  objectId(req.params.id, 'Job'); await requireCurrentJob(req.params.id);
  const result = await Lead.deleteMany({ status: 'pending', searchJobId: req.params.id });
  await releaseIfResolved(req.params.id); res.json({ deletedCount: result.deletedCount });
});
router.get('/leads', async (req, res) => {
  const { page, limit } = parsePagination(req.query); const filter = {};
  if (req.query.status) filter.status = assertLeadStatus(req.query.status);
  if (filter.status === 'pending') { const current = await currentDiscovery(); if (!current.job) return res.json({ items: [], pagination: pagination(page, limit, 0) }); filter.searchJobId = current.job._id; }
  if (req.query.search?.trim()) { const term = req.query.search.trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); filter.$or = [{ businessName: { $regex: term, $options: 'i' } }, { domain: { $regex: term, $options: 'i' } }, { email: { $regex: term, $options: 'i' } }]; }
  const [items, total] = await Promise.all([Lead.find(filter).sort({ discoveredAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), Lead.countDocuments(filter)]); res.json({ items, pagination: pagination(page, limit, total) });
});
router.patch('/leads/bulk-status', async (req, res) => {
  const ids = uniqueObjectIds(req.body.ids); const status = assertPermanentLeadStatus(req.body.status); const current = await currentDiscovery();
  if (!current.job) throw new AppError('There are no pending leads to update.', 409, 'NO_PENDING_SEARCH');
  const result = await Lead.updateMany({ _id: { $in: ids }, status: 'pending', searchJobId: current.job._id }, { $set: { status } });
  const pendingCount = await releaseIfResolved(current.job._id); res.json({ modifiedCount: result.modifiedCount, pendingCount });
});
router.get('/leads/:id', async (req, res) => { objectId(req.params.id, 'Lead'); const lead = await Lead.findById(req.params.id).lean(); if (!lead) throw new AppError('Lead not found', 404, 'NOT_FOUND'); res.json(lead); });
router.patch('/leads/:id/status', async (req, res) => {
  objectId(req.params.id, 'Lead'); const requested = assertPermanentLeadStatus(req.body.status);
  const current = await currentDiscovery(); if (!current.job) throw new AppError('There are no pending leads to update.', 409, 'NO_PENDING_SEARCH');
  const lead = await Lead.findOneAndUpdate({ _id: req.params.id, status: 'pending', searchJobId: current.job._id }, { $set: { status: requested } }, { new: true, runValidators: true }).lean();
  if (!lead) throw new AppError('Only pending leads from the current search can be updated.', 409, 'INVALID_LEAD_TRANSITION'); await releaseIfResolved(current.job._id); res.json(lead);
});
router.get('/search-history', async (req, res) => { const { page, limit } = parsePagination(req.query); const [items, total] = await Promise.all([SearchHistory.find({}).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), SearchHistory.countDocuments()]); res.json({ items, pagination: pagination(page, limit, total) }); });
router.get('/health', (_req, res) => res.status(mongoose.connection.readyState === 1 ? 200 : 503).json({ status: mongoose.connection.readyState === 1 ? 'ok' : 'degraded', database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' }));
export default router;
