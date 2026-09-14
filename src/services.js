import { GoogleGenAI } from '@google/genai';
import { env } from './config.js';
import { Lead, SearchHistory, SearchJob } from './models.js';
import { AppError, isSafePublicUrl, isValidPublicEmail, logger, normalizeDomain, normalizeEmail, normalizeUrl } from './utils.js';

const candidateSchema = {
  type: 'object', properties: { candidates: { type: 'array', items: { type: 'object', properties: {
    businessName: { type: 'string' }, officialWebsite: { type: 'string' }, email: { type: ['string', 'null'] }, phone: { type: ['string', 'null'] }, isEcommerce: { type: 'boolean' },
    websiteSourceUrl: { type: ['string', 'null'] }, emailSourceUrl: { type: ['string', 'null'] }, phoneSourceUrl: { type: ['string', 'null'] }
  }, required: ['businessName', 'officialWebsite', 'email', 'phone', 'isEcommerce', 'websiteSourceUrl', 'emailSourceUrl', 'phoneSourceUrl'] } } }, required: ['candidates']
};

async function discoverWithGemini(input, variation) {
  if (!env.geminiApiKey) throw new AppError('Lead discovery is temporarily unavailable. Please try again.', 503, 'GEMINI_UNAVAILABLE');
  const prompt = `Find up to ${env.discoveryBatchSize} real e-commerce businesses for cold-lead research. Search: ${variation}. Category: ${input.category}. Location: ${input.location}. Optional keywords: ${input.keywords || 'none'}.
Return unique businesses and unique normalized domains within this response. Return only real businesses that actually sell products online and their official website. Never use directories, marketplaces, social profiles, seller/profile pages, or contact aggregators as the official website. A candidate MUST include an exact publicly listed business email supported by emailSourceUrl; never infer, guess, fabricate, or use private/personal contact information. Phone is optional: return null when unavailable. Include source URLs for the official website and all returned contact data. Do not return duplicates.`;
  try {
    const ai = new GoogleGenAI({ apiKey: env.geminiApiKey });
    const response = await ai.models.generateContent({ model: env.geminiModel, contents: prompt, config: { tools: [{ googleSearch: {} }, { urlContext: {} }], responseMimeType: 'application/json', responseJsonSchema: candidateSchema, temperature: 0.2 } });
    const parsed = JSON.parse(response.text || '{"candidates":[]}');
    return Array.isArray(parsed.candidates) ? parsed.candidates : [];
  } catch { throw new AppError('Lead discovery is temporarily unavailable. Please try again.', 503, 'GEMINI_UNAVAILABLE'); }
}

const variations = (input) => [`${input.category} e-commerce businesses in ${input.location}`, `online ${input.category} stores in ${input.location}`, `${input.category} brands with online shops in ${input.location}`, `${input.keywords || 'independent'} ${input.category} online brands ${input.location}`];
// Keep pass-local candidate repetition out of the database path. MongoDB's
// unique domain index remains the final guard for concurrent writers.
export function createSeenDomainTracker() {
  const seenDomains = new Set();
  return (domain) => {
    if (seenDomains.has(domain)) return true;
    seenDomains.add(domain);
    return false;
  };
}
function prepareLead(candidate, input) {
  const website = normalizeUrl(candidate?.officialWebsite), domain = normalizeDomain(website), email = normalizeEmail(candidate?.email);
  if (!candidate?.isEcommerce || !candidate.businessName?.trim() || !website || !domain || !isSafePublicUrl(website) || !isValidPublicEmail(email) || !candidate.emailSourceUrl || !isSafePublicUrl(candidate.emailSourceUrl)) return null;
  return { businessName: candidate.businessName.trim().slice(0, 200), domain, website, email, phone: typeof candidate.phone === 'string' && candidate.phone.trim() ? candidate.phone.trim().slice(0, 80) : null, category: input.category, location: input.location, keywords: input.keywords, isEcommerce: true, websiteSourceUrl: isSafePublicUrl(candidate.websiteSourceUrl) ? normalizeUrl(candidate.websiteSourceUrl) : website, emailSourceUrl: normalizeUrl(candidate.emailSourceUrl), phoneSourceUrl: isSafePublicUrl(candidate.phoneSourceUrl) ? normalizeUrl(candidate.phoneSourceUrl) : null, discoverySource: 'gemini_google_search' };
}

const terminalStatuses = ['completed', 'failed', 'cancelled'];
const leaseToken = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function recordHistory(jobId) {
  const job = await SearchJob.findById(jobId).lean();
  if (!job || !terminalStatuses.includes(job.status)) return;
  await SearchHistory.updateOne({ searchJobId: job._id }, { $set: {
    category: job.category, location: job.location, keywords: job.keywords,
    requestedCount: job.requestedCount, foundCount: job.foundCount,
    duplicateCount: job.duplicateCount, rejectedCount: job.rejectedCount, status: job.status
  } }, { upsert: true });
}

async function heartbeat(jobId, token) {
  const now = new Date();
  const result = await SearchJob.updateOne(
    { _id: jobId, status: 'running', workerToken: token },
    { $set: { workerHeartbeatAt: now, workerLeaseUntil: new Date(now.getTime() + env.discoveryLeaseMs) } }
  );
  return result.modifiedCount === 1;
}

// Claiming uses a lease, so a process killed by a serverless runtime can be
// continued by the next recovery invocation. A token prevents an old worker
// from completing or failing a job claimed by its replacement.
export async function runDiscovery(jobId) {
  const token = leaseToken(); const now = new Date();
  const claim = await SearchJob.findOneAndUpdate({ _id: jobId, $or: [
    { status: 'queued' },
    { status: 'running', workerLeaseUntil: { $lt: now } }
  ] }, { $set: {
    status: 'running', startedAt: now, workerToken: token, workerHeartbeatAt: now,
    workerLeaseUntil: new Date(now.getTime() + env.discoveryLeaseMs), errorMessage: null
  }, $inc: { executionAttempt: 1, retryCount: 1 } }, { new: true });
  if (!claim) return;
  if (claim.executionAttempt > env.discoveryMaxWorkerAttempts) {
    await SearchJob.updateOne({ _id: jobId, status: 'running', workerToken: token }, { $set: { status: 'failed', completedAt: new Date(), errorMessage: 'Discovery worker exceeded its retry limit.', lastError: 'Worker lease expired too many times.', workerLeaseUntil: null } });
    await recordHistory(jobId); return;
  }
  const input = claim.toObject(); let found = input.foundCount || 0, duplicates = input.duplicateCount || 0, rejected = input.rejectedCount || 0;
  const wasSeenThisJob = createSeenDomainTracker();
  try {
    for (let attempt = 0; attempt < env.discoveryMaxAttempts && found < input.requestedCount; attempt += 1) {
      if (!await heartbeat(jobId, token)) return;
      const candidates = await discoverWithGemini(input, variations(input)[attempt % variations(input).length]);
      if (!await heartbeat(jobId, token)) return;
      for (const candidate of candidates) {
        if (found >= input.requestedCount) break;
        const lead = prepareLead(candidate, input);
        if (!lead) { rejected += 1; continue; }
        if (wasSeenThisJob(lead.domain)) { duplicates += 1; continue; }
        if (await Lead.exists({ domain: lead.domain })) { duplicates += 1; continue; }
        // Cancellation or a replacement worker invalidates this write.
        if (!await SearchJob.exists({ _id: jobId, status: 'running', workerToken: token })) return;
        try { await Lead.create({ ...lead, status: 'pending', searchJobId: jobId }); found += 1; } catch (error) { if (error?.code === 11000) duplicates += 1; else throw error; }
      }
      if (!await heartbeat(jobId, token)) return;
      await SearchJob.updateOne({ _id: jobId, status: 'running', workerToken: token }, { $set: { foundCount: found, duplicateCount: duplicates, rejectedCount: rejected } });
    }
    const complete = await SearchJob.updateOne({ _id: jobId, status: 'running', workerToken: token }, { $set: { status: 'completed', foundCount: found, duplicateCount: duplicates, rejectedCount: rejected, completedAt: new Date(), workerLeaseUntil: null } });
    if (complete.modifiedCount) await recordHistory(jobId);
  } catch (error) {
    logger.error('Discovery job failed', jobId, error.message);
    const failed = await SearchJob.updateOne({ _id: jobId, status: 'running', workerToken: token }, { $set: { status: 'failed', errorMessage: 'Lead discovery is temporarily unavailable. Please try again.', lastError: error.message, completedAt: new Date(), foundCount: found, duplicateCount: duplicates, rejectedCount: rejected, workerLeaseUntil: null } });
    if (failed.modifiedCount) await recordHistory(jobId);
  }
}

export async function recoverStaleDiscoveries() {
  const stale = await SearchJob.find({ $or: [{ status: 'queued' }, { status: 'running', workerLeaseUntil: { $lt: new Date() } }] }).select('_id').limit(10).lean();
  await Promise.allSettled(stale.map(job => runDiscovery(job._id)));
  return stale.length;
}
