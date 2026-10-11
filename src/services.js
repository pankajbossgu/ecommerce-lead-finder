import { GoogleGenAI } from '@google/genai';
import crypto from 'node:crypto';
import { env, Lead, SearchHistory, SearchJob } from './models.js';
import { AppError, isSafePublicUrl, isValidPublicEmail, logger, normalizeBusinessName, normalizeDomain, normalizeEmail, normalizePhone, normalizePhoneIdentity, normalizeSocialProfileUrl, normalizeUrl } from './utils.js';
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
  return `Find up to ${env.discoveryBatchSize} genuine physical-product e-commerce businesses for cold-lead research. Discovery channel: ${channel}. Search: ${variation}. Category: ${input.category}. Location: ${input.location}. Optional keywords: ${input.keywords || 'none'}.\n\nTarget D2C brands, online retailers, independent e-commerce stores, Shopify stores, and brands that sell and ship physical products online. Discovery/ranking preferences: prioritize businesses that appear to sell physical products directly to consumers; ship across India or Pan India; offer Cash on Delivery (COD); operate an online store or Shopify store; actively promote products through Instagram, Facebook, or other social media; offer multiple products or SKUs; and serve customers across multiple Indian states or cities. These are discovery signals only, not mandatory requirements: do not reject an otherwise valid e-commerce lead when COD, Pan-India delivery, Shopify, or social advertising is not publicly confirmed. Treat D2C, Shopify, COD, and similar terms as preferences only when they fit the user's category or optional keywords; they are never universal requirements. Reject e-commerce/marketing/web-development agencies, SaaS or software companies, consultants, logistics or service providers, directories, marketplaces that only list other sellers, social-only businesses, and businesses that do not sell physical products online.\n\n${channelInstructions[channel] || channelInstructions.website}\n\nEvery saved candidate MUST have a legitimate official business website representing that business. Never use a directory, marketplace/seller page, or social profile as officialWebsite. Use Google Search grounding and URL Context to check the official website first, including its Contact, About, footer, support, help, shipping, and other legitimate pages on the same official domain. A candidate MUST include an exact, publicly displayed business email and its exact emailSourceUrl. Never infer, guess, construct, or fabricate an email, and never use private/personal contact information. First use a valid public email displayed on the official website; set emailSourceType to "website" and set emailSourceUrl to the relevant official-domain page. Only if the website has no usable public business email may you use a readily available official business social profile (such as Instagram, Facebook, or LinkedIn) as a fallback. For a social fallback, set emailSourceType to "social", set isOfficialSocialProfile to true, and use that exact social profile URL as emailSourceUrl. Verify reasonable ownership evidence before doing so: matching business name, linked/matching official domain, matching branding, or matching location. Do not use a similarly named or unrelated social account. Do not use third-party lead databases, directory listings, or search snippets as source evidence. Phone is optional. Include socialProfiles when verified and use null for absent optional data.${exclusionInstructions}`;
};
export function classifyGeminiApiError(error) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status) || null;
  const raw = String(error?.message || error?.error?.message || error || 'Unknown API error');
  const safeDetail = raw.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted API key]').replace(/(api[_ -]?key|authorization|bearer)\s*[:=]?\s*[^\s,;]+/ig, '$1 [redacted]').replace(/\s+/g, ' ').slice(0, 240);
  const source = `${status || ''} ${raw}`.toLowerCase();
  let code = 'API_REQUEST_FAILED', title = 'API request failed', message = 'The discovery service returned an error.', suggestion = 'Check the API provider status and try again.';
  if (/api key not valid|invalid api key|api_key_invalid|invalid credential|unauthenticated/.test(source) || status === 401) { code = 'API_KEY_INVALID'; title = 'API key is invalid'; message = 'The configured API key was rejected.'; suggestion = 'Check the API key in your deployment environment, update it if needed, and redeploy.'; }
  else if (/permission denied|permission_denied|forbidden|access denied/.test(source) || status === 403) { code = 'API_PERMISSION_DENIED'; title = 'API permission denied'; message = 'The API key does not have permission to use this service or model.'; suggestion = 'Check API access, project permissions, and whether the model is enabled for this key.'; }
  else if (/quota|resource_exhausted|billing|credit|insufficient.*(fund|credit)|exceeded.*(limit|quota)/.test(source)) { code = 'API_QUOTA_EXCEEDED'; title = 'API quota or credits exhausted'; message = 'The API provider reported a quota, billing, or credit limit.'; suggestion = 'Check provider usage, billing, and quota limits before retrying.'; }
  else if (/rate.?limit|too many requests/.test(source) || status === 429) { code = 'API_RATE_LIMITED'; title = 'API rate limit reached'; message = 'The API provider is temporarily limiting requests.'; suggestion = 'Wait for the rate-limit window to reset, then retry.'; }
  else if (/model.*(not found|unavailable|does not exist)|not_found.*model/.test(source)) { code = 'API_MODEL_UNAVAILABLE'; title = 'Model unavailable'; message = 'The configured model is unavailable or not enabled for this API key.'; suggestion = 'Check the model name and provider access settings.'; }
  else if (/timeout|timed out|deadline exceeded|etimedout|econnreset|enotfound|network|fetch failed/.test(source)) { code = 'API_NETWORK_OR_TIMEOUT'; title = 'API connection timed out'; message = 'The app could not complete its request to the API service.'; suggestion = 'Check the provider status and network connectivity, then retry.'; }
  else if (/json|parse|empty response|no text|malformed/.test(source)) { code = 'API_INVALID_RESPONSE'; title = 'API returned an unusable response'; message = 'The API request did not return a usable discovery response.'; suggestion = 'Retry the search; if it repeats, check the provider response and model configuration.'; }
  else if ((status && status >= 500) || /internal server error|service unavailable|temporarily unavailable/.test(source)) { code = 'API_PROVIDER_UNAVAILABLE'; title = 'API provider temporarily unavailable'; message = 'The API provider returned a server-side error.'; suggestion = 'Check provider status and retry after the service recovers.'; }
  return { code, title, message, suggestion, detail: safeDetail, httpStatus: status };
}
function geminiApiAppError(error) {
  const diagnostic = classifyGeminiApiError(error);
  const appError = new AppError(diagnostic.message, 503, diagnostic.code);
  appError.apiDiagnostic = diagnostic;
  return appError;
}
async function discoverWithGemini(input, variation, discoveredDomains = [], channel = 'website') {
  if (!env.geminiApiKey) {
    const error = new AppError('The discovery API key is not configured.', 503, 'API_KEY_MISSING');
    error.apiDiagnostic = { code: 'API_KEY_MISSING', title: 'API key missing', message: 'No API key is configured for the discovery service.', suggestion: 'Add the valid API key to the deployment environment and redeploy.', detail: 'GEMINI_API_KEY is missing.', httpStatus: null };
    throw error;
  }
  try {
    const ai = new GoogleGenAI({ apiKey: env.geminiApiKey });
    const response = await ai.models.generateContent({ model: 'gemini-3.1-flash-lite', contents: buildDiscoveryPrompt(input, variation, discoveredDomains, channel), config: { tools: [{ googleSearch: {} }, { urlContext: {} }], responseMimeType: 'application/json', responseJsonSchema: candidateSchema, temperature: 0.2 } });
    if (response?.promptFeedback?.blockReason) throw new Error(`Request blocked by provider: ${response.promptFeedback.blockReason}`);
    if (typeof response?.text !== 'string' || !response.text.trim()) throw new Error('Gemini returned an empty response');
    const parsed = JSON.parse(response.text);
    return Array.isArray(parsed.candidates) ? parsed.candidates : [];
  } catch (error) {
    if (error?.apiDiagnostic) throw error;
    const appError = geminiApiAppError(error);
    logger.error('Discovery API request failed', { code: appError.code, status: appError.apiDiagnostic.httpStatus, detail: appError.apiDiagnostic.detail });
    throw appError;
  }
}
const websiteVariations = input => [`${input.category} e-commerce businesses in ${input.location}`, `online ${input.category} stores in ${input.location}`, `${input.category} brands with online shops in ${input.location}`, `${input.keywords || 'independent'} ${input.category} online brands ${input.location}`];
const socialVariations = input => [`site:instagram.com ${input.category} brands ${input.location}`, `site:facebook.com ${input.category} shop ${input.location}`, `site:linkedin.com/company ${input.category} e-commerce ${input.location}`, `${input.keywords || input.category} public business profiles ${input.location}`, `site:instagram.com ${input.category} brands COD "Pan India" ${input.location}`, `site:instagram.com ${input.category} brands "cash on delivery" ${input.location}`, `site:facebook.com ${input.category} "COD" "Pan India delivery" ${input.location}`, `${input.category} D2C Shopify COD ${input.location}`];
export async function discoverWebsiteCandidates(input, discover = discoverWithGemini) { const variation = websiteVariations(input)[(input.variationIndex || 0) % websiteVariations(input).length]; return discover(input, variation, input.discoveredDomains || [], 'website'); }
export async function discoverSocialCandidates(input, discover = discoverWithGemini) { const variation = socialVariations(input)[(input.variationIndex || 0) % socialVariations(input).length]; return discover(input, variation, input.discoveredDomains || [], 'social'); }
const normalizedSocialProfiles = profiles => Object.fromEntries(['instagram', 'facebook', 'linkedin'].map(key => [key, normalizeSocialProfileUrl(profiles?.[key]) || null]));
export function normalizeCandidate(candidate, source, input = {}) { return { ...candidate, identityLocation: candidate?.location || input.location || null, socialProfiles: normalizedSocialProfiles(candidate?.socialProfiles), discoverySources: [source], sourceUrls: [...new Set([candidate?.officialWebsite, candidate?.websiteSourceUrl, candidate?.emailSourceUrl, ...Object.values(candidate?.socialProfiles || {})].map(normalizeUrl).filter(Boolean))] }; }
const profileKeys = candidate => new Set(Object.values(candidate.socialProfiles || {}).map(normalizeSocialProfileUrl).filter(Boolean));
export function candidatesMatch(a, b) {
  const domainA = normalizeDomain(a.officialWebsite), domainB = normalizeDomain(b.officialWebsite);
  if (domainA && domainA === domainB) return true;
  const emailA = normalizeEmail(a.email), emailB = normalizeEmail(b.email);
  if (emailA && emailA === emailB) return true;
  const phoneA = normalizePhoneIdentity(a.phone), phoneB = normalizePhoneIdentity(b.phone);
  if (phoneA && phoneA === phoneB) return true;
  const profilesA = profileKeys(a); if ([...profileKeys(b)].some(key => profilesA.has(key))) return true;
  // Name similarity is intentionally not enough.  An exact conservative name
  // key must agree with an explicit location before it can resolve a sparse
  // social candidate to its website-discovered counterpart.
  const nameA = normalizeBusinessName(a.businessName), nameB = normalizeBusinessName(b.businessName);
  return Boolean(nameA && nameA === nameB && a.identityLocation && b.identityLocation && normalizeBusinessName(a.identityLocation) === normalizeBusinessName(b.identityLocation));
}
const fill = (target, source, key) => { if (!target[key] && source[key]) target[key] = source[key]; };
export function mergeCandidates(candidates = []) { const merged = []; for (const candidate of candidates) { const existing = merged.find(item => candidatesMatch(item, candidate)); if (!existing) { merged.push({ ...candidate, discoverySources: [...new Set(candidate.discoverySources || [])] }); continue; } ['officialWebsite', 'websiteSourceUrl', 'email', 'emailSourceUrl', 'emailSourceType', 'phone', 'phoneSourceUrl'].forEach(key => fill(existing, candidate, key)); existing.discoverySources = [...new Set([...(existing.discoverySources || []), ...(candidate.discoverySources || [])])]; existing.sourceUrls = [...new Set([...(existing.sourceUrls || []), ...(candidate.sourceUrls || [])])]; existing.socialProfiles = { ...(existing.socialProfiles || {}), ...Object.fromEntries(Object.entries(candidate.socialProfiles || {}).filter(([, value]) => value)) }; } return merged; }
export async function runDiscoveryChannels({ mode = 'hybrid', ...input }, discover = { website: discoverWebsiteCandidates, social: discoverSocialCandidates }) { const channels = mode === 'website' ? ['website'] : mode === 'social' ? ['social'] : ['website', 'social']; const results = await Promise.allSettled(channels.map(channel => discover[channel](input))); return { channels, results, candidates: mergeCandidates(results.flatMap((result, index) => result.status === 'fulfilled' ? result.value.map(candidate => normalizeCandidate(candidate, channels[index], input)) : [])), failures: results.flatMap((result, index) => result.status === 'rejected' ? [{ channel: channels[index], error: result.reason }] : []) }; }
export function prepareLead(candidate, input) { const website = normalizeUrl(candidate?.officialWebsite), domain = normalizeDomain(website), email = normalizeEmail(candidate?.email), emailSourceUrl = normalizeUrl(candidate?.emailSourceUrl); const websiteEmail = (candidate?.emailSourceType === 'website' || candidate?.emailSourceType == null) && isOfficialWebsiteUrl(emailSourceUrl, domain); const socialEmail = candidate?.emailSourceType === 'social' && candidate?.isOfficialSocialProfile === true && isSupportedSocialProfileUrl(emailSourceUrl); if (!candidate?.isEcommerce || !candidate.businessName?.trim() || !website || !domain || isSupportedSocialProfileUrl(website) || !isSafePublicUrl(website) || !isValidPublicEmail(email) || !emailSourceUrl || !isSafePublicUrl(emailSourceUrl) || !(websiteEmail || socialEmail)) return null; return { businessName: candidate.businessName.trim().slice(0, 200), domain, website, email, phone: normalizePhone(candidate.phone), category: input.category, location: input.location, keywords: input.keywords, isEcommerce: true, websiteSourceUrl: isSafePublicUrl(candidate.websiteSourceUrl) ? normalizeUrl(candidate.websiteSourceUrl) : website, emailSourceUrl, phoneSourceUrl: isSafePublicUrl(candidate.phoneSourceUrl) ? normalizeUrl(candidate.phoneSourceUrl) : null, discoverySource: 'gemini_google_search', discoverySources: [...new Set(candidate.discoverySources || [input.mode === 'social' ? 'social' : 'website'])], socialProfiles: normalizedSocialProfiles(candidate.socialProfiles), sourceUrls: [...new Set(candidate.sourceUrls || [])] }; }
export const activeJobFilter = (jobId, token) => ({ _id: jobId, status: 'running', workerToken: token });
const ownedWorkerFilter = (jobId, token) => ({ ...activeJobFilter(jobId, token), workerLeaseExpiresAt: { $gt: new Date() } });
const workerLease = () => new Date(Date.now() + 55_000);
async function renewWorkerLease(jobId, token) {
  return SearchJob.findOneAndUpdate(ownedWorkerFilter(jobId, token), { $set: { workerLeaseExpiresAt: workerLease() } }, { new: true }).lean();
} export const isTerminalJobStatus = status => ['completed', 'failed', 'cancelled'].includes(status); export const resolvedDuplicateFilter = domain => ({ domain, status: { $in: ['saved', 'discarded'] } });
export function duplicateReasonForLead(lead, matches = [], jobId = null) {
  const domainDuplicate = matches.some(match => match.domain === lead.domain && (['saved', 'discarded'].includes(match.status) || (jobId && String(match.searchJobId) === String(jobId))));
  const emailDuplicate = matches.some(match => normalizeEmail(match.emailNormalized || match.email) === lead.email);
  return domainDuplicate && emailDuplicate ? 'duplicate_domain_and_email' : domainDuplicate ? 'duplicate_domain' : emailDuplicate ? 'duplicate_email' : null;
}
export async function findLeadDuplicateReason(lead, jobId = null, excludeId = null) {
  const filter = { $or: [{ domain: lead.domain, status: { $in: ['saved', 'discarded'] } }, ...(jobId ? [{ searchJobId: jobId, domain: lead.domain }] : []), { emailNormalized: lead.email }, { email: lead.email }] };
  if (excludeId) filter._id = { $ne: excludeId };
  const matches = await Lead.find(filter).select('domain email emailNormalized status searchJobId').lean();
  return duplicateReasonForLead(lead, matches, jobId);
}
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
        outcome.channels.forEach((channel, index) => {
          const result = outcome.results[index];
          const diagnostic = result.status === 'rejected' ? result.reason?.apiDiagnostic : null;
          progress[channel] = { status: result.status === 'fulfilled' ? 'completed' : 'failed', candidates: result.status === 'fulfilled' ? result.value.length : 0, error: result.status === 'rejected' ? (diagnostic?.message || 'The discovery API request failed.') : null };
        });
        const apiErrors = [...(job.apiErrors || [])];
        outcome.failures.forEach(({ channel, error }) => {
          const diagnostic = error?.apiDiagnostic;
          if (!diagnostic) return;
          const key = `${channel}:${diagnostic.code}:${diagnostic.detail || ''}`;
          if (!apiErrors.some(item => `${item.channel}:${item.code}:${item.detail || ''}` === key)) apiErrors.push({ channel, ...diagnostic, occurredAt: new Date() });
        });
        progress.merging = 'completed'; progress.validation = 'running';
        const saved = await SearchJob.findOneAndUpdate(ownedWorkerFilter(jobId, token), { $set: { checkpoint: { ...checkpoint, variationIndex, candidateIndex: 0, batchId: crypto.randomUUID(), candidates }, discoveryProgress: progress, apiErrors }, $inc: { attempts: 1 } }, { new: true }).lean();
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
      else {
        const duplicateReason = await findLeadDuplicateReason(lead, jobId);
        if (duplicateReason) update.$inc.duplicateCount = 1;
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
  } catch (error) {
    logger.error('Discovery job failed', jobId, error.message);
    const diagnostic = error?.apiDiagnostic;
    const update = { status: 'failed', errorMessage: error instanceof AppError ? error.message : 'Lead discovery could not finish. Please try again.', completedAt: new Date(), workerToken: null, workerLeaseExpiresAt: null };
    if (diagnostic) {
      const existing = job.apiErrors || [];
      const key = `discovery:${diagnostic.code}:${diagnostic.detail || ''}`;
      update.apiErrors = existing.some(item => `discovery:${item.code}:${item.detail || ''}` === key) ? existing : [...existing, { channel: 'discovery', ...diagnostic, occurredAt: new Date() }];
    }
    await SearchJob.updateOne(ownedWorkerFilter(jobId, token), { $set: update });
  }
}
