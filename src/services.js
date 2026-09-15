import { GoogleGenAI } from '@google/genai';
import crypto from 'node:crypto';
import { env, Lead, SearchHistory, SearchJob } from './models.js';
import { AppError, isSafePublicUrl, isValidPublicEmail, logger, normalizeDomain, normalizeEmail, normalizePhone, normalizeUrl } from './utils.js';
const socialProfileHosts = new Set(['instagram.com', 'facebook.com', 'linkedin.com']);
const candidateSchema = { type: 'object', properties: { candidates: { type: 'array', items: { type: 'object', properties: { businessName: { type: 'string' }, officialWebsite: { type: ['string', 'null'] }, email: { type: ['string', 'null'] }, phone: { type: ['string', 'null'] }, isEcommerce: { type: 'boolean' }, websiteSourceUrl: { type: ['string', 'null'] }, emailSourceUrl: { type: ['string', 'null'] }, emailSourceType: { type: ['string', 'null'], enum: ['website', 'social', null] }, isOfficialSocialProfile: { type: ['boolean', 'null'] }, phoneSourceUrl: { type: ['string', 'null'] }, socialProfiles: { type: ['object', 'null'] } }, required: ['businessName', 'officialWebsite', 'email', 'phone', 'isEcommerce', 'websiteSourceUrl', 'emailSourceUrl', 'emailSourceType', 'isOfficialSocialProfile', 'phoneSourceUrl'] } } }, required: ['candidates'] };
export const normalizeDiscoveredDomains = (domains = []) => [...new Set((Array.isArray(domains) ? domains : []).map(normalizeDomain).filter(Boolean))];
const isSupportedSocialProfileUrl = sourceUrl => { const sourceDomain = normalizeDomain(sourceUrl); return Boolean(sourceDomain && (socialProfileHosts.has(sourceDomain) || [...socialProfileHosts].some(host => sourceDomain.endsWith(`.${host}`)))); };
const isOfficialWebsiteUrl = (sourceUrl, domain) => { const sourceDomain = normalizeDomain(sourceUrl); return sourceDomain === domain || Boolean(sourceDomain && sourceDomain.endsWith(`.${domain}`)); };
const channelInstructions = {
  website: 'Prioritize official business websites, D2C brands, online retailers, independent stores, and relevant local or regional businesses. Do not use social profiles as discovery targets.',
  social: 'Use several diverse, publicly indexed social/business discovery queries (for example Instagram, Facebook, LinkedIn company profiles and relevant legitimate platforms). Identify the business and its official website where possible. Do not treat a social URL as an official website and do not invent an absent website.'
};
export const buildDiscoveryPrompt = (input, variation, discoveredDomains = [], channel = 'website') => {
  const exclusions = normalizeDiscoveredDomains(discoveredDomains);
  const exclusionInstructions = exclusions.length ? `\nPreviously discovered websites — DO NOT RETURN:\n${exclusions.join('\n')}\nDo not return these businesses or domains. Find different businesses relevant to the user's category and location. Do not simply change the URL or page and return the same business; treat exact normalized domain matching as the business identity signal. Find businesses not present in the previously discovered domain list.` : '';
  return `Find up to ${env.discoveryBatchSize} genuine physical-product e-commerce businesses for cold-lead research. Discovery channel: ${channel}. Search: ${variation}. Category: ${input.category}. Location: ${input.location}. Optional keywords: ${input.keywords || 'none'}.\n\nTarget D2C brands, online retailers, independent e-commerce stores, Shopify stores, and brands that sell and ship physical products online. Treat D2C, Shopify, COD, and similar terms as preferences only when they fit the user's category or optional keywords; they are never universal requirements. Reject e-commerce/marketing/web-development agencies, SaaS or software companies, consultants, logistics or service providers, directories, marketplaces that only list other sellers, social-only businesses, and businesses that do not sell physical products online.\n\n${channelInstructions[channel] || channelInstructions.website}\n\nEvery saved candidate MUST have a legitimate official business website representing that business. Never use a directory, marketplace/seller page, or social profile as officialWebsite. Use Google Search grounding and URL Context to check the official website first, including its Contact, About, footer, support, help, shipping, and other legitimate pages on the same official domain. A candidate MUST include an exact, publicly displayed business email and its exact emailSourceUrl. Never infer, guess, construct, or fabricate an email, and never use private/personal contact information. First use a valid public email displayed on the official website; set emailSourceType to "website" and set emailSourceUrl to the relevant official-domain page. Only if the website has no usable public business email may you use a readily available official business social profile (such as Instagram, Facebook, or LinkedIn) as a fallback. For a social fallback, set emailSourceType to "social", set isOfficialSocialProfile to true, and use that exact social profile URL as emailSourceUrl. Verify reasonable ownership evidence before doing so: matching business name, linked/matching official domain, matching branding, or matching location. Do not use a similarly named or unrelated social account. Do not use third-party lead databases, directory listings, or search snippets as source evidence. Phone is optional. Include socialProfiles when verified and use null for absent optional data.${exclusionInstructions}`;
};
async function discoverWithGemini(input, variation, discoveredDomains = [], channel = 'website') { if (!env.geminiApiKey) throw new AppError('Lead discovery is temporarily unavailable. Please try again.', 503, 'GEMINI_UNAVAILABLE'); try { const ai = new GoogleGenAI({ apiKey: env.geminiApiKey }); const response = await ai.models.generateContent({ model: 'gemini-3.1-flash-lite', contents: buildDiscoveryPrompt(input, variation, discoveredDomains, channel), config: { tools: [{ googleSearch: {} }, { urlContext: {} }], responseMimeType: 'application/json', responseJsonSchema: candidateSchema, temperature: 0.2 } }); const parsed = JSON.parse(response.text || '{"candidates":[]}'); return Array.isArray(parsed.candidates) ? parsed.candidates : []; } catch { throw new AppError('Lead discovery is temporarily unavailable. Please try again.', 503, 'GEMINI_UNAVAILABLE'); } }
const websiteVariations = input => [`${input.category} e-commerce businesses in ${input.location}`, `online ${input.category} stores in ${input.location}`, `${input.category} brands with online shops in ${input.location}`, `${input.keywords || 'independent'} ${input.category} online brands ${input.location}`];
const socialVariations = input => [`site:instagram.com ${input.category} brands ${input.location}`, `site:facebook.com ${input.category} shop ${input.location}`, `site:linkedin.com/company ${input.category} e-commerce ${input.location}`, `${input.keywords || input.category} public business profiles ${input.location}`];
export async function discoverWebsiteCandidates(input, discover = discoverWithGemini) { const variation = websiteVariations(input)[(input.variationIndex || 0) % websiteVariations(input).length]; return discover(input, variation, input.discoveredDomains || [], 'website'); }
export async function discoverSocialCandidates(input, discover = discoverWithGemini) { const variation = socialVariations(input)[(input.variationIndex || 0) % socialVariations(input).length]; return discover(input, variation, input.discoveredDomains || [], 'social'); }
const normalizedSocialProfiles = profiles => Object.fromEntries(['instagram', 'facebook', 'linkedin'].map(key => [key, isSupportedSocialProfileUrl(profiles?.[key]) ? normalizeUrl(profiles[key]) : null]));
export function normalizeCandidate(candidate, source) { return { ...candidate, socialProfiles: normalizedSocialProfiles(candidate?.socialProfiles), discoverySources: [source], sourceUrls: [...new Set([candidate?.officialWebsite, candidate?.websiteSourceUrl, candidate?.emailSourceUrl, ...Object.values(candidate?.socialProfiles || {})].map(normalizeUrl).filter(Boolean))] }; }
export function mergeCandidates(candidates = []) { const merged = []; for (const candidate of candidates) { const domain = normalizeDomain(candidate.officialWebsite), email = normalizeEmail(candidate.email); const existing = merged.find(item => (domain && normalizeDomain(item.officialWebsite) === domain) || (email && normalizeEmail(item.email) === email)); if (!existing) { merged.push({ ...candidate, discoverySources: [...new Set(candidate.discoverySources || [])] }); continue; } existing.discoverySources = [...new Set([...(existing.discoverySources || []), ...(candidate.discoverySources || [])])]; existing.sourceUrls = [...new Set([...(existing.sourceUrls || []), ...(candidate.sourceUrls || [])])]; existing.socialProfiles = { ...(existing.socialProfiles || {}), ...Object.fromEntries(Object.entries(candidate.socialProfiles || {}).filter(([, value]) => value)) }; } return merged; }
export async function runDiscoveryChannels({ mode = 'hybrid', ...input }, discover = { website: discoverWebsiteCandidates, social: discoverSocialCandidates }) { const channels = mode === 'website' ? ['website'] : mode === 'social' ? ['social'] : ['website', 'social']; const results = await Promise.allSettled(channels.map(channel => discover[channel](input))); return { channels, results, candidates: mergeCandidates(results.flatMap((result, index) => result.status === 'fulfilled' ? result.value.map(candidate => normalizeCandidate(candidate, channels[index])) : [])), failures: results.flatMap((result, index) => result.status === 'rejected' ? [{ channel: channels[index], error: result.reason }] : []) }; }
export function prepareLead(candidate, input) { const website = normalizeUrl(candidate?.officialWebsite), domain = normalizeDomain(website), email = normalizeEmail(candidate?.email), emailSourceUrl = normalizeUrl(candidate?.emailSourceUrl); const websiteEmail = (candidate?.emailSourceType === 'website' || candidate?.emailSourceType == null) && isOfficialWebsiteUrl(emailSourceUrl, domain); const socialEmail = candidate?.emailSourceType === 'social' && candidate?.isOfficialSocialProfile === true && isSupportedSocialProfileUrl(emailSourceUrl); if (!candidate?.isEcommerce || !candidate.businessName?.trim() || !website || !domain || isSupportedSocialProfileUrl(website) || !isSafePublicUrl(website) || !isValidPublicEmail(email) || !emailSourceUrl || !isSafePublicUrl(emailSourceUrl) || !(websiteEmail || socialEmail)) return null; return { businessName: candidate.businessName.trim().slice(0, 200), domain, website, email, phone: normalizePhone(candidate.phone), category: input.category, location: input.location, keywords: input.keywords, isEcommerce: true, websiteSourceUrl: isSafePublicUrl(candidate.websiteSourceUrl) ? normalizeUrl(candidate.websiteSourceUrl) : website, emailSourceUrl, phoneSourceUrl: isSafePublicUrl(candidate.phoneSourceUrl) ? normalizeUrl(candidate.phoneSourceUrl) : null, discoverySource: 'gemini_google_search', discoverySources: [...new Set(candidate.discoverySources || [input.mode === 'social' ? 'social' : 'website'])], socialProfiles: normalizedSocialProfiles(candidate.socialProfiles), sourceUrls: [...new Set(candidate.sourceUrls || [])] }; }
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
    let checkpoint = job.checkpoint && typeof job.checkpoint === 'object' ? job.checkpoint : { variationIndex: 0, candidateIndex: 0, candidates: [], discoveredDomains: [] };
    checkpoint = { ...checkpoint, discoveredDomains: normalizeDiscoveredDomains(checkpoint.discoveredDomains) };
    // Old numeric checkpoints cannot identify a model response; deliberately
    // start one fresh persisted variation once during the schema migration.
    if (!Array.isArray(checkpoint.candidates) || !checkpoint.candidates.length) {
      if (job.attempts >= env.discoveryMaxAttempts) checkpoint = { ...checkpoint, candidates: [] };
      else {
        const variationIndex = Number(checkpoint.variationIndex) || 0;
        const outcome = await runDiscoveryChannels({ ...job, variationIndex, discoveredDomains: checkpoint.discoveredDomains });
        const candidates = outcome.candidates;
        const progress = { ...(job.discoveryProgress || {}) };
        outcome.channels.forEach((channel, index) => { const result = outcome.results[index]; progress[channel] = { status: result.status === 'fulfilled' ? 'completed' : 'failed', candidates: result.status === 'fulfilled' ? result.value.length : 0, error: result.status === 'rejected' ? 'Lead discovery is temporarily unavailable. Please try again.' : null }; });
        progress.merging = 'completed'; progress.validation = 'running';
        const saved = await SearchJob.findOneAndUpdate(ownedWorkerFilter(jobId, token), { $set: { checkpoint: { ...checkpoint, variationIndex, candidateIndex: 0, batchId: crypto.randomUUID(), candidates }, discoveryProgress: progress }, $inc: { attempts: 1 } }, { new: true }).lean();
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
      const candidateDomain = isSupportedSocialProfileUrl(candidate?.officialWebsite) ? null : normalizeDomain(candidate?.officialWebsite);
      const discoveredDomains = new Set(normalizeDiscoveredDomains(checkpoint.discoveredDomains));
      if (candidateDomain && discoveredDomains.has(candidateDomain)) {
        const advanced = await SearchJob.findOneAndUpdate({ ...ownedWorkerFilter(jobId, token), 'checkpoint.candidateIndex': checkpoint.candidateIndex }, { $inc: { duplicateCount: 1, 'checkpoint.candidateIndex': 1 } }, { new: true }).lean();
        if (!advanced) return;
        checkpoint = advanced.checkpoint;
        job.foundCount = advanced.foundCount;
        continue;
      }
      // Persist an identifiable domain before validation so rejected candidates
      // still become exclusions after a restart or resume.
      if (candidateDomain) {
        const tracked = await SearchJob.findOneAndUpdate({ ...ownedWorkerFilter(jobId, token), 'checkpoint.candidateIndex': checkpoint.candidateIndex }, { $addToSet: { 'checkpoint.discoveredDomains': candidateDomain } }, { new: true }).lean();
        if (!tracked) return;
        checkpoint = tracked.checkpoint;
      }
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
      if (batchFinished) await SearchJob.updateOne(ownedWorkerFilter(jobId, token), { $set: { checkpoint: { ...fresh.checkpoint, variationIndex: fresh.checkpoint.variationIndex + 1, candidateIndex: 0, batchId: null, candidates: [] }, workerToken: null, workerLeaseExpiresAt: null } });
      else await SearchJob.updateOne(ownedWorkerFilter(jobId, token), { $set: { workerToken: null, workerLeaseExpiresAt: null } });
      return;
    }
    const result = await SearchJob.updateOne(ownedWorkerFilter(jobId, token), { $set: { status: 'completed', completedAt: new Date(), workerToken: null, workerLeaseExpiresAt: null, 'discoveryProgress.validation': 'completed' } });
    if (result.modifiedCount) await SearchHistory.create({ category: fresh.category, location: fresh.location, keywords: fresh.keywords, requestedCount: fresh.requestedCount, mode: fresh.mode || 'hybrid', discoveryProgress: fresh.discoveryProgress, foundCount: fresh.foundCount });
  } catch (error) { logger.error('Discovery job failed', jobId, error.message); await SearchJob.updateOne(ownedWorkerFilter(jobId, token), { $set: { status: 'failed', errorMessage: error instanceof AppError ? error.message : 'Lead discovery is temporarily unavailable. Please try again.', completedAt: new Date(), workerToken: null, workerLeaseExpiresAt: null } }); }
}
