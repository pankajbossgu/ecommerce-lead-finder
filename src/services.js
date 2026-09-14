import { GoogleGenAI } from '@google/genai';
import crypto from 'node:crypto';
import { env, Lead, SearchHistory, SearchJob } from './models.js';
import { AppError, isSafePublicUrl, isValidPublicEmail, logger, normalizeDomain, normalizeEmail, normalizePhone, normalizeUrl } from './utils.js';
const candidateSchema = { type: 'object', properties: { candidates: { type: 'array', items: { type: 'object', properties: { businessName: { type: 'string' }, officialWebsite: { type: 'string' }, email: { type: ['string', 'null'] }, phone: { type: ['string', 'null'] }, isEcommerce: { type: 'boolean' }, websiteSourceUrl: { type: ['string', 'null'] }, emailSourceUrl: { type: ['string', 'null'] }, phoneSourceUrl: { type: ['string', 'null'] } }, required: ['businessName', 'officialWebsite', 'email', 'phone', 'isEcommerce', 'websiteSourceUrl', 'emailSourceUrl', 'phoneSourceUrl'] } } }, required: ['candidates'] };
async function discoverWithGemini(input, variation) { if (!env.geminiApiKey) throw new AppError('Lead discovery is temporarily unavailable. Please try again.', 503, 'GEMINI_UNAVAILABLE'); try { const ai = new GoogleGenAI({ apiKey: env.geminiApiKey }); const response = await ai.models.generateContent({ model: 'gemini-3.1-flash-lite', contents: `Find up to ${env.discoveryBatchSize} real e-commerce businesses for cold-lead research. Search: ${variation}. Category: ${input.category}. Location: ${input.location}. Optional keywords: ${input.keywords || 'none'}. Return only businesses that actually sell products online and have a likely official website. Never use directories, marketplaces, social profiles, or seller pages as official websites. A candidate MUST include an exact publicly listed business email supported by emailSourceUrl; never infer, guess, or fabricate an email. Phone is optional. Include source URLs and use null for absent optional data.`, config: { tools: [{ googleSearch: {} }, { urlContext: {} }], responseMimeType: 'application/json', responseJsonSchema: candidateSchema, temperature: 0.2 } }); const parsed = JSON.parse(response.text || '{"candidates":[]}'); return Array.isArray(parsed.candidates) ? parsed.candidates : []; } catch { throw new AppError('Lead discovery is temporarily unavailable. Please try again.', 503, 'GEMINI_UNAVAILABLE'); } }
const variations = input => [`${input.category} e-commerce businesses in ${input.location}`, `online ${input.category} stores in ${input.location}`, `${input.category} brands with online shops in ${input.location}`, `${input.keywords || 'independent'} ${input.category} online brands ${input.location}`];
function prepareLead(candidate, input) { const website = normalizeUrl(candidate?.officialWebsite), domain = normalizeDomain(website), email = normalizeEmail(candidate?.email); if (!candidate?.isEcommerce || !candidate.businessName?.trim() || !website || !domain || !isSafePublicUrl(website) || !isValidPublicEmail(email) || !candidate.emailSourceUrl || !isSafePublicUrl(candidate.emailSourceUrl)) return null; return { businessName: candidate.businessName.trim().slice(0, 200), domain, website, email, phone: normalizePhone(candidate.phone), category: input.category, location: input.location, keywords: input.keywords, isEcommerce: true, websiteSourceUrl: isSafePublicUrl(candidate.websiteSourceUrl) ? normalizeUrl(candidate.websiteSourceUrl) : website, emailSourceUrl: normalizeUrl(candidate.emailSourceUrl), phoneSourceUrl: isSafePublicUrl(candidate.phoneSourceUrl) ? normalizeUrl(candidate.phoneSourceUrl) : null, discoverySource: 'gemini_google_search' }; }
export const activeJobFilter = (jobId, token) => ({ _id: jobId, status: 'running', workerToken: token }); export const isTerminalJobStatus = status => ['completed', 'failed', 'cancelled'].includes(status); export const resolvedDuplicateFilter = domain => ({ domain, status: { $in: ['saved', 'discarded'] } });
export async function runDiscovery(jobId) {
  const now = new Date(), token = crypto.randomUUID();
  const job = await SearchJob.findOneAndUpdate({ _id: jobId, status: { $in: ['queued', 'running'] }, $or: [{ workerLeaseExpiresAt: null }, { workerLeaseExpiresAt: { $lte: now } }] }, { $set: { status: 'running', workerToken: token, workerLeaseExpiresAt: new Date(now.getTime() + 55_000), startedAt: now } }, { new: true }).lean();
  if (!job) return;
  // Reconcile only this job's persisted results. This also makes an interrupted
  // write safe without ever mixing older unresolved leads into this result set.
  const persistedFound = await Lead.countDocuments({ searchJobId: jobId });
  if (persistedFound > job.foundCount) await SearchJob.updateOne(activeJobFilter(jobId, token), { $set: { foundCount: persistedFound } });
  job.foundCount = Math.max(job.foundCount, persistedFound);
  try {
    let checkpoint = job.checkpoint && typeof job.checkpoint === 'object' ? job.checkpoint : { variationIndex: 0, candidateIndex: 0, candidates: [] };
    // Old numeric checkpoints cannot identify a model response; deliberately
    // start one fresh persisted variation once during the schema migration.
    if (!Array.isArray(checkpoint.candidates) || !checkpoint.candidates.length) {
      if (job.attempts >= env.discoveryMaxAttempts) checkpoint = { ...checkpoint, candidates: [] };
      else {
        const variationIndex = Number(checkpoint.variationIndex) || 0;
        const candidates = await discoverWithGemini(job, variations(job)[variationIndex % variations(job).length]);
        const saved = await SearchJob.findOneAndUpdate(activeJobFilter(jobId, token), { $set: { checkpoint: { variationIndex, candidateIndex: 0, batchId: crypto.randomUUID(), candidates } }, $inc: { attempts: 1 } }, { new: true }).lean();
        if (!saved) return;
        job.attempts = saved.attempts; checkpoint = saved.checkpoint;
      }
    }
    // Advance the durable cursor after every candidate. Retried invocations use
    // this saved response and resume at candidateIndex, never batch zero.
    while (job.foundCount < job.requestedCount && checkpoint.candidateIndex < checkpoint.candidates.length) {
      const candidate = checkpoint.candidates[checkpoint.candidateIndex];
      const lead = prepareLead(candidate, job);
      let update = { $inc: { 'checkpoint.candidateIndex': 1 } };
      if (!lead) update.$inc.rejectedCount = 1;
      else if (await Lead.exists({ $or: [resolvedDuplicateFilter(lead.domain), { searchJobId: jobId, domain: lead.domain }] })) update.$inc.duplicateCount = 1;
      else {
        // Reserve a slot atomically before the insert. A second worker/retry
        // cannot exceed requestedCount even if a lease is reclaimed.
        const reserved = await SearchJob.findOneAndUpdate({ ...activeJobFilter(jobId, token), foundCount: { $lt: job.requestedCount }, 'checkpoint.candidateIndex': checkpoint.candidateIndex }, { $inc: { foundCount: 1, 'checkpoint.candidateIndex': 1 } }, { new: true }).lean();
        if (!reserved) break;
        try {
          const created = await Lead.create({ ...lead, searchJobId: jobId });
          // Cancellation clears the token. If it won the race with create, remove
          // this just-created unresolved row so cancelled jobs retain no results.
          if (!await SearchJob.exists(activeJobFilter(jobId, token))) {
            await Lead.deleteOne({ _id: created._id, status: 'new' });
            return;
          }
          job.foundCount = reserved.foundCount; checkpoint = reserved.checkpoint; continue;
        }
        catch (error) {
          // Roll back the reservation only while this worker still owns an active job.
          await SearchJob.updateOne(activeJobFilter(jobId, token), { $inc: { foundCount: -1, duplicateCount: error?.code === 11000 ? 1 : 0 } });
          if (error?.code !== 11000) throw error;
          job.foundCount = Math.max(0, reserved.foundCount - 1); checkpoint = reserved.checkpoint; continue;
        }
      }
      const advanced = await SearchJob.findOneAndUpdate({ ...activeJobFilter(jobId, token), 'checkpoint.candidateIndex': checkpoint.candidateIndex }, update, { new: true }).lean();
      if (!advanced) break;
      checkpoint = advanced.checkpoint; job.foundCount = advanced.foundCount;
    }
    const fresh = await SearchJob.findOne(activeJobFilter(jobId, token)).lean(); if (!fresh) return;
    const batchFinished = fresh.checkpoint.candidateIndex >= fresh.checkpoint.candidates.length;
    const complete = fresh.foundCount >= fresh.requestedCount || (batchFinished && fresh.attempts >= env.discoveryMaxAttempts);
    if (!complete) {
      // Mark a completed variation before releasing the lease. The next poll
      // generates only the next variation, retaining this job's exact history.
      if (batchFinished) await SearchJob.updateOne(activeJobFilter(jobId, token), { $set: { checkpoint: { variationIndex: fresh.checkpoint.variationIndex + 1, candidateIndex: 0, batchId: null, candidates: [] }, workerToken: null, workerLeaseExpiresAt: null } });
      else await SearchJob.updateOne(activeJobFilter(jobId, token), { $set: { workerToken: null, workerLeaseExpiresAt: null } });
      return;
    }
    const result = await SearchJob.updateOne(activeJobFilter(jobId, token), { $set: { status: 'completed', completedAt: new Date(), workerToken: null, workerLeaseExpiresAt: null } });
    if (result.modifiedCount) await SearchHistory.create({ category: fresh.category, location: fresh.location, keywords: fresh.keywords, requestedCount: fresh.requestedCount, foundCount: fresh.foundCount });
  } catch (error) { logger.error('Discovery job failed', jobId, error.message); await SearchJob.updateOne(activeJobFilter(jobId, token), { $set: { status: 'failed', errorMessage: error instanceof AppError ? error.message : 'Lead discovery is temporarily unavailable. Please try again.', completedAt: new Date(), workerToken: null, workerLeaseExpiresAt: null } }); }
}
