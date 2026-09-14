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
  const job = await SearchJob.findOneAndUpdate({ _id: jobId, status: { $in: ['queued', 'running'] }, $or: [{ workerLeaseExpiresAt: null }, { workerLeaseExpiresAt: { $lte: now } }] }, { $set: { status: 'running', workerToken: token, workerLeaseExpiresAt: new Date(now.getTime() + 55_000), startedAt: now }, $inc: { attempts: 1 } }, { new: true }).lean();
  if (!job) return;
  // Reconcile a write that completed just before a serverless request ended, before
  // its counter checkpoint could be acknowledged.
  const persistedFound = await Lead.countDocuments({ searchJobId: jobId });
  if (persistedFound > job.foundCount) await SearchJob.updateOne(activeJobFilter(jobId, token), { $set: { foundCount: persistedFound } });
  job.foundCount = Math.max(job.foundCount, persistedFound);
  try {
    if (job.foundCount < job.requestedCount && job.attempts <= env.discoveryMaxAttempts) {
      const candidates = await discoverWithGemini(job, variations(job)[(job.attempts - 1) % variations(job).length]);
      for (const candidate of candidates) {
        const current = await SearchJob.findOne(activeJobFilter(jobId, token)).lean();
        if (!current || current.foundCount >= current.requestedCount) break;
        const lead = prepareLead(candidate, job);
        if (!lead) { await SearchJob.updateOne(activeJobFilter(jobId, token), { $inc: { rejectedCount: 1, checkpoint: 1 } }); continue; }
        if (await Lead.exists({ $or: [resolvedDuplicateFilter(lead.domain), { searchJobId: jobId, domain: lead.domain }] })) { await SearchJob.updateOne(activeJobFilter(jobId, token), { $inc: { duplicateCount: 1, checkpoint: 1 } }); continue; }
        try { await Lead.create({ ...lead, searchJobId: jobId }); await SearchJob.updateOne(activeJobFilter(jobId, token), { $inc: { foundCount: 1, checkpoint: 1 } }); } catch (error) { if (error?.code === 11000) await SearchJob.updateOne(activeJobFilter(jobId, token), { $inc: { duplicateCount: 1, checkpoint: 1 } }); else throw error; }
      }
    }
    const fresh = await SearchJob.findOne(activeJobFilter(jobId, token)).lean(); if (!fresh) return;
    const complete = fresh.foundCount >= fresh.requestedCount || fresh.attempts >= env.discoveryMaxAttempts;
    if (!complete) { await SearchJob.updateOne(activeJobFilter(jobId, token), { $set: { workerToken: null, workerLeaseExpiresAt: null } }); return; }
    const result = await SearchJob.updateOne(activeJobFilter(jobId, token), { $set: { status: 'completed', completedAt: new Date(), workerToken: null, workerLeaseExpiresAt: null } });
    if (result.modifiedCount) await SearchHistory.create({ category: fresh.category, location: fresh.location, keywords: fresh.keywords, requestedCount: fresh.requestedCount, foundCount: fresh.foundCount });
  } catch (error) { logger.error('Discovery job failed', jobId, error.message); await SearchJob.updateOne(activeJobFilter(jobId, token), { $set: { status: 'failed', errorMessage: error instanceof AppError ? error.message : 'Lead discovery is temporarily unavailable. Please try again.', completedAt: new Date(), workerToken: null, workerLeaseExpiresAt: null } }); }
}
