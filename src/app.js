import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { connectDatabase, env, Lead, SearchHistory, SearchJob, OutreachTemplate, Campaign, CampaignRecipient, OutreachActivity } from './models.js';
import { sendEmail } from './services/email.js';
import { runDiscovery } from './services.js';
import { AppError, applyDateRange, assertLeadStatus, logger, parseDateRange, parseDiscoveryInput, parsePagination } from './utils.js';

const app = express();
const publicDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public');
const allowedOrigins = env.appOrigin.split(',').map((origin) => origin.trim()).filter(Boolean);
const sendRateLimit = rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many send requests. Please wait before trying again.' } });
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
  if (req.query.status === 'saved' && req.query.outreach && req.query.outreach !== 'all') { const contactedIds = await OutreachActivity.distinct('leadId', { status: { $in: ['sent', 'manual_sent'] } }); if (req.query.outreach === 'contacted') filter._id = { $in: contactedIds }; else if (req.query.outreach === 'never') filter._id = { $nin: contactedIds }; else throw new AppError('Invalid outreach filter', 400, 'VALIDATION_ERROR'); }
  const [items, total] = await Promise.all([Lead.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(), Lead.countDocuments(filter)]);
  const ids = items.map(item => item._id); const activityRows = ids.length ? await OutreachActivity.aggregate([{ $match: { leadId: { $in: ids }, status: { $in: ['sent', 'manual_sent', 'failed'] } } }, { $sort: { sentAt: -1, createdAt: -1 } }, { $group: { _id: '$leadId', count: { $sum: 1 }, channels: { $addToSet: '$channel' }, statuses: { $addToSet: '$status' }, lastContactedAt: { $first: '$sentAt' } } }]) : []; const outreach = new Map(activityRows.map(row => [String(row._id), { count: row.count, email: row.channels.includes('email'), whatsapp: row.channels.includes('whatsapp'), failed: row.statuses.includes('failed'), lastContactedAt: row.lastContactedAt }]));
  res.json({ items: items.map((item, index) => ({ ...item, outreach: outreach.get(String(item._id)) || { count: 0 }, srNo: (page - 1) * limit + index + 1 })), pagination: pagination(page, limit, total) });
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
async function updateCampaignCounts(campaignId) { const rows = await CampaignRecipient.aggregate([{ $match: { campaignId: new mongoose.Types.ObjectId(campaignId) } }, { $group: { _id: null, total: { $sum: 1 }, email: { $sum: { $cond: [{ $eq: ['$channel', 'email'] }, 1, 0] } }, whatsapp: { $sum: { $cond: [{ $eq: ['$channel', 'whatsapp'] }, 1, 0] } }, sent: { $sum: { $cond: [{ $in: ['$status', ['sent', 'manual_sent']] }, 1, 0] } }, failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } }, pending: { $sum: { $cond: [{ $in: ['$status', ['pending', 'ready', 'sending']] }, 1, 0] } } } }]); const c = rows[0] || { total: 0, email: 0, whatsapp: 0, sent: 0, failed: 0, pending: 0 }; const terminal = c.pending === 0 && c.total > 0; await Campaign.findByIdAndUpdate(campaignId, { $set: { recipientCount: c.total, emailCount: c.email, whatsappCount: c.whatsapp, sentCount: c.sent, failedCount: c.failed, pendingCount: c.pending, ...(terminal ? { status: c.failed === c.total ? 'failed' : 'completed', completedAt: new Date() } : {}) } }); return c; }
async function requireCampaign(id) { objectId(id, 'Campaign'); const campaign = await Campaign.findById(id).lean(); if (!campaign) throw new AppError('Campaign not found', 404, 'NOT_FOUND'); return campaign; }
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
app.post('/api/campaigns/:id/recipients', async (req, res) => { const campaign = await requireCampaign(req.params.id); if (!['draft', 'ready', 'paused'].includes(campaign.status)) throw new AppError('Campaign cannot accept recipients while sending or completed', 409, 'CAMPAIGN_LOCKED'); const leadIds = Array.isArray(req.body?.leadIds) ? [...new Set(req.body.leadIds)] : []; const includeContacted = req.body?.includeContacted === true; if (!leadIds.length || leadIds.length > 100 || !leadIds.every(mongoose.isValidObjectId)) throw new AppError('Choose one to 100 valid saved leads', 400, 'VALIDATION_ERROR'); const leads = await Lead.find({ _id: { $in: leadIds }, status: 'saved' }).lean(); if (leads.length !== leadIds.length) throw new AppError('Every selected lead must still be saved', 409, 'LEADS_NOT_SAVED'); const activities = await OutreachActivity.find({ leadId: { $in: leadIds }, status: { $in: ['sent', 'manual_sent'] } }).lean(); const contacted = new Set(activities.map(a => `${a.leadId}:${a.channel}`)); const docs = []; for (const lead of leads) for (const channel of campaign.channels) { const value = channel === 'email' ? lead.email : lead.phone; if (!value || (channel === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) continue; if (!includeContacted && contacted.has(`${lead._id}:${channel}`)) continue; docs.push({ campaignId: campaign._id, leadId: lead._id, channel, recipient: value, templateId: channel === 'email' ? campaign.emailTemplateId : campaign.whatsappTemplateId, status: 'ready', idempotencyKey: `campaign:${campaign._id}:lead:${lead._id}:channel:${channel}` }); }
  let created = 0; for (const doc of docs) { try { await CampaignRecipient.create(doc); created += 1; } catch (error) { if (error?.code !== 11000) throw error; } } const counts = await updateCampaignCounts(campaign._id); await Campaign.findByIdAndUpdate(campaign._id, { $set: { status: counts.total ? 'ready' : 'draft' } }); res.status(201).json({ created, excludedContacted: leadIds.length * campaign.channels.length - docs.length, counts }); });
app.get('/api/campaigns/:id/recipients', async (req, res) => { await requireCampaign(req.params.id); const items = await CampaignRecipient.find({ campaignId: req.params.id }).populate('leadId', 'businessName email phone domain').sort({ createdAt: -1 }).lean(); res.json({ items }); });
async function sendRecipient(campaignId, recipientId) { const recipient = await recipientFor(campaignId, recipientId); if (recipient.channel !== 'email') throw new AppError('WhatsApp messages must be sent manually', 409, 'MANUAL_WHATSAPP_REQUIRED'); const claimed = await CampaignRecipient.findOneAndUpdate({ _id: recipient._id, campaignId, status: { $in: ['ready', 'pending', 'failed'] } }, { $set: { status: 'sending', failureReason: null }, $inc: { attempts: 1 } }, { new: true }).lean(); if (!claimed) return { skipped: true }; const lead = await Lead.findOne({ _id: claimed.leadId, status: 'saved' }).lean(); const template = await OutreachTemplate.findOne({ _id: claimed.templateId, type: 'email' }).lean(); if (!lead || !template || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claimed.recipient)) { const reason = !lead ? 'Lead is no longer saved' : !template ? 'Email template no longer exists' : 'Invalid email address'; await CampaignRecipient.updateOne({ _id: claimed._id, status: 'sending' }, { $set: { status: 'failed', failedAt: new Date(), failureReason: reason } }); await OutreachActivity.create({ leadId: claimed.leadId, campaignId, channel: 'email', templateId: claimed.templateId, recipient: claimed.recipient, subject: template?.subject || null, status: 'failed', failedAt: new Date(), failureReason: reason }); return { failed: true }; }
  try { const providerMessageId = await sendEmail({ to: claimed.recipient, subject: renderTemplate(template.subject, lead), text: renderTemplate(template.body, lead), idempotencyKey: claimed.idempotencyKey }); const sentAt = new Date(); await CampaignRecipient.updateOne({ _id: claimed._id, status: 'sending' }, { $set: { status: 'sent', sentAt, providerMessageId } }); await OutreachActivity.create({ leadId: lead._id, campaignId, channel: 'email', templateId: template._id, recipient: claimed.recipient, subject: renderTemplate(template.subject, lead), status: 'sent', sentAt, providerMessageId }); return { sent: true }; } catch (error) { await CampaignRecipient.updateOne({ _id: claimed._id, status: 'sending' }, { $set: { status: 'failed', failedAt: new Date(), failureReason: error.message.slice(0, 500) } }); await OutreachActivity.create({ leadId: claimed.leadId, campaignId, channel: 'email', templateId: claimed.templateId, recipient: claimed.recipient, status: 'failed', failedAt: new Date(), failureReason: error.message.slice(0, 500) }); return { failed: true }; } }
app.post('/api/campaigns/:id/recipients/:recipientId/send', sendRateLimit, async (req, res) => { await requireCampaign(req.params.id); const result = await sendRecipient(req.params.id, req.params.recipientId); const counts = await updateCampaignCounts(req.params.id); res.json({ ...result, counts }); });
app.post('/api/campaigns/:id/send', sendRateLimit, async (req, res) => { const campaign = await requireCampaign(req.params.id); if (!campaign.channels.includes('email')) throw new AppError('Campaign has no email channel', 409, 'NO_EMAIL_CHANNEL'); await Campaign.findByIdAndUpdate(campaign._id, { $set: { status: 'sending', startedAt: campaign.startedAt || new Date(), completedAt: null } }); const recipients = await CampaignRecipient.find({ campaignId: campaign._id, channel: 'email', status: { $in: ['ready', 'pending', 'failed'] } }).limit(100).lean(); const results = []; for (const recipient of recipients) results.push(await sendRecipient(String(campaign._id), String(recipient._id))); const counts = await updateCampaignCounts(campaign._id); res.json({ processed: results.length, counts, status: counts.pending ? 'sending' : 'completed' }); });
app.post('/api/campaigns/:id/recipients/:recipientId/manual-sent', async (req, res) => { const recipient = await recipientFor(req.params.id, req.params.recipientId); if (recipient.channel !== 'whatsapp') throw new AppError('Only WhatsApp recipients can be marked manually sent', 409, 'VALIDATION_ERROR'); const updated = await CampaignRecipient.findOneAndUpdate({ _id: recipient._id, status: { $in: ['ready', 'pending'] } }, { $set: { status: 'manual_sent', sentAt: new Date() } }, { new: true }).lean(); if (updated) await OutreachActivity.create({ leadId: updated.leadId, campaignId: updated.campaignId, channel: 'whatsapp', templateId: updated.templateId, recipient: updated.recipient, status: 'manual_sent', sentAt: updated.sentAt }); const counts = await updateCampaignCounts(req.params.id); res.json({ recipient: updated || recipient, counts }); });
app.post('/api/campaigns/:id/recipients/:recipientId/skip', async (req, res) => { const recipient = await recipientFor(req.params.id, req.params.recipientId); const updated = await CampaignRecipient.findOneAndUpdate({ _id: recipient._id, status: { $in: ['ready', 'pending'] } }, { $set: { status: 'skipped' } }, { new: true }).lean(); if (updated) await OutreachActivity.create({ leadId: updated.leadId, campaignId: updated.campaignId, channel: updated.channel, templateId: updated.templateId, recipient: updated.recipient, status: 'skipped' }); res.json({ recipient: updated || recipient, counts: await updateCampaignCounts(req.params.id) }); });
app.get('/api/leads/:id/outreach', async (req, res) => { objectId(req.params.id, 'Lead'); const items = await OutreachActivity.find({ leadId: req.params.id }).populate('campaignId', 'name').populate('templateId', 'name').sort({ sentAt: -1, createdAt: -1 }).lean(); res.json({ items }); });
app.get('/api/campaigns/:id/activity', async (req, res) => { await requireCampaign(req.params.id); res.json({ items: await OutreachActivity.find({ campaignId: req.params.id }).sort({ createdAt: -1 }).lean() }); });
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
