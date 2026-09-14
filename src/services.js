import { GoogleGenAI } from '@google/genai';
import crypto from 'node:crypto';
import { env, Lead, SearchHistory, SearchJob } from './models.js';
import { AppError, isSafePublicUrl, isValidPublicEmail, logger, normalizeDomain, normalizeEmail, normalizePhone, normalizeUrl } from './utils.js';
const candidateSchema = { type: 'object', properties: { candidates: { type: 'array', items: { type: 'object', properties: { businessName: { type: 'string' }, officialWebsite: { type: 'string' }, email: { type: ['string', 'null'] }, phone: { type: ['string', 'null'] }, isEcommerce: { type: 'boolean' }, websiteSourceUrl: { type: ['string', 'null'] }, emailSourceUrl: { type: ['string', 'null'] }, phoneSourceUrl: { type: ['string', 'null'] } }, required: ['businessName', 'officialWebsite', 'email', 'phone', 'isEcommerce', 'websiteSourceUrl', 'emailSourceUrl', 'phoneSourceUrl'] } } }, required: ['candidates'] };
async function discoverWithGemini(input, variation) { if (!env.geminiApiKey) throw new AppError('Lead discovery is temporarily unavailable. Please try again.', 503, 'GEMINI_UNAVAILABLE'); try { const ai = new GoogleGenAI({ apiKey: env.geminiApiKey }); const response = await ai.models.generateContent({ model: 'gemini-3.1-flash-lite', contents: `Find up to ${env.discoveryBatchSize} real e-commerce businesses for cold-lead research. Search: ${variation}. Category: ${input.category}. Location: ${input.location}. Optional keywords: ${input.keywords || 'none'}. Return only businesses that actually sell products online and have a likely official website. Never use directories, marketplaces, social profiles, or seller pages as official websites. A candidate MUST include an exact publicly listed business email supported by emailSourceUrl; never infer, guess, or fabricate an email. Phone is optional. Include source URLs and use null for absent optional data.`, config: { tools: [{ googleSearch: {} }, { urlContext: {} }], responseMimeType: 'application/json', responseJsonSchema: candidateSchema, temperature: 0.2 } }); const parsed = JSON.parse(response.text || '{"candidates":[]}'); return Array.isArray(parsed.candidates) ? parsed.candidates : []; } catch { throw new AppError('Lead discovery is temporarily unavailable. Please try again.', 503, 'GEMINI_UNAVAILABLE'); } }
const variations = input => [`${input.category} e-commerce businesses in ${input.location}`, `online ${input.category} stores in ${input.location}`, `${input.category} brands with online shops in ${input.location}`, `${input.keywords || 'independent'} ${input.category} online brands ${input.location}`];
function prepareLead(candidate, input) { const website = normalizeUrl(candidate?.officialWebsite), domain = normalizeDomain(website), email = normalizeEmail(candidate?.email); if (!candidate?.isEcommerce || !candidate.businessName?.trim() || !website || !domain || !isSafePublicUrl(website) || !isValidPublicEmail(email) || !candidate.emailSourceUrl || !isSafePublicUrl(candidate.emailSourceUrl)) return null; return { businessName: candidate.businessName.trim().slice(0, 200), domain, website, email, phone: normalizePhone(candidate.phone), category: input.category, location: input.location, keywords: input.keywords, isEcommerce: true, websiteSourceUrl: isSafePublicUrl(candidate.websiteSourceUrl) ? normalizeUrl(candidate.websiteSourceUrl) : website, emailSourceUrl: normalizeUrl(candidate.emailSourceUrl), phoneSourceUrl: isSafePublicUrl(candidate.phoneSourceUrl) ? normalizeUrl(candidate.phoneSourceUrl) : null, discoverySource: 'gemini_google_search' }; }
export const activeJobFilter = (jobId, token) => ({ _id: jobId, status: 'running', workerToken: token });
const ownedWorkerFilter = (jobId, token) => ({ ...activeJobFilter(jobId, token), workerLeaseExpiresAt: { $gt: new Date() } });
const workerLease = () => new Date(Date.now() + 55_000);
async function renewWorkerLease(jobId, token) {
  return SearchJob.findOneAndUpdate(ownedWorkerFilter(jobId, token), { $set: { workerLeaseExpiresAt: workerLease() } }, { new: true }).lean();
} export const isTerminalJobStatus = status => ['completed', 'failed', 'cancelled'].includes(status); export const resolvedDuplicateFilter = domain => ({ domain, status: { $in: ['saved', 'discarded'] } });
export async function runDiscovery(jobId) {
  const now = new Date(), token = crypto.randomUUID();
  const job = await SearchJob.findOneAndUpdate({ _id: jobId, status: { $in: ['queued', 'running'] }, $or: [{ workerLeaseExpiresAt: null }, { workerLeaseExpiresAt: { $lte: now } }] }, { $set: { status: 'running', workerToken: token, workerLeaseExpiresAt: workerLease(), startedAt: now } }, { new: true }).lean();
  if (!job) return;
  // Reconcile only this job's persisted results. This also makes an interrupted
  // write safe without ever mixing older unresolved leads into this result set.
  const persistedFound = await Lead.countDocuments({ searchJobId: jobId });
  if (persistedFound > job.foundCount) await SearchJob.updateOne(ownedWorkerFilter(jobId, token), { $set: { foundCount: persistedFound } });
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
        const saved = await SearchJob.findOneAndUpdate(ownedWorkerFilter(jobId, token), { $set: { checkpoint: { variationIndex, candidateIndex: 0, batchId: crypto.randomUUID(), candidates } }, $inc: { attempts: 1 } }, { new: true }).lean();
        if (!saved) return;
        job.attempts = saved.attempts; checkpoint = saved.checkpoint;
      }
    }
    // Write a qualified lead before advancing the checkpoint. If a process dies
    // between these two operations, the job resumes at this candidate; its unique
    // job/domain index makes the retry harmless and reconciliation restores count.
    while (job.foundCount < job.requestedCount && checkpoint.candidateIndex < checkpoint.candidates.length) {
      const owned = await renewWorkerLease(jobId, token);
      if (!owned) return;
      job.foundCount = owned.foundCount;
      checkpoint = owned.checkpoint;
      const candidate = checkpoint.candidates[checkpoint.candidateIndex];
      const lead = prepareLead(candidate, job);
      let update = { $inc: { 'checkpoint.candidateIndex': 1 } };
      if (!lead) update.$inc.rejectedCount = 1;
      else if (await Lead.exists({ $or: [resolvedDuplicateFilter(lead.domain), { searchJobId: jobId, domain: lead.domain }] })) update.$inc.duplicateCount = 1;
      else {
        // The lease is renewed immediately before the insert. A stale worker cannot
        // advance a cursor or finalise; a recovered insert is reconciled on retry.
        let created;
        try {
          created = await Lead.create({ ...lead, searchJobId: jobId });
        } catch (error) {
          if (error?.code !== 11000) throw error;
          update.$inc.duplicateCount = 1;
        }
        if (created) {
          const advanced = await SearchJob.findOneAndUpdate(
            { ...ownedWorkerFilter(jobId, token), foundCount: { $lt: job.requestedCount }, 'checkpoint.candidateIndex': checkpoint.candidateIndex },
            { $inc: { foundCount: 1, 'checkpoint.candidateIndex': 1 } }, { new: true }
          ).lean();
          if (!advanced) {
            // Cancellation or a lost lease won the race. Do not leave an orphaned
            // unresolved result for a worker that no longer has authority.
            await Lead.deleteOne({ _id: created._id, status: 'new' });
            return;
          }
          job.foundCount = advanced.foundCount;
          checkpoint = advanced.checkpoint;
          continue;
        }
      }
      const advanced = await SearchJob.findOneAndUpdate({ ...ownedWorkerFilter(jobId, token), 'checkpoint.candidateIndex': checkpoint.candidateIndex }, update, { new: true }).lean();
      if (!advanced) return;
      checkpoint = advanced.checkpoint;
      job.foundCount = advanced.foundCount;
    }
    const fresh = await SearchJob.findOne(ownedWorkerFilter(jobId, token)).lean(); if (!fresh) return;
    const batchFinished = fresh.checkpoint.candidateIndex >= fresh.checkpoint.candidates.length;
    const complete = fresh.foundCount >= fresh.requestedCount || (batchFinished && fresh.attempts >= env.discoveryMaxAttempts);
    if (!complete) {
      // Mark a completed variation before releasing the lease. The next poll
      // generates only the next variation, retaining this job's exact history.
      if (batchFinished) await SearchJob.updateOne(ownedWorkerFilter(jobId, token), { $set: { checkpoint: { variationIndex: fresh.checkpoint.variationIndex + 1, candidateIndex: 0, batchId: null, candidates: [] }, workerToken: null, workerLeaseExpiresAt: null } });
      else await SearchJob.updateOne(ownedWorkerFilter(jobId, token), { $set: { workerToken: null, workerLeaseExpiresAt: null } });
      return;
    }
    const result = await SearchJob.updateOne(ownedWorkerFilter(jobId, token), { $set: { status: 'completed', completedAt: new Date(), workerToken: null, workerLeaseExpiresAt: null } });
    if (result.modifiedCount) await SearchHistory.create({ category: fresh.category, location: fresh.location, keywords: fresh.keywords, requestedCount: fresh.requestedCount, foundCount: fresh.foundCount });
  } catch (error) { logger.error('Discovery job failed', jobId, error.message); await SearchJob.updateOne(ownedWorkerFilter(jobId, token), { $set: { status: 'failed', errorMessage: error instanceof AppError ? error.message : 'Lead discovery is temporarily unavailable. Please try again.', completedAt: new Date(), workerToken: null, workerLeaseExpiresAt: null } }); }
}
