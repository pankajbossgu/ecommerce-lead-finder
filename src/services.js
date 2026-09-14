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
Return only businesses that actually sell products online and have a likely official website. Never use directories, marketplaces, social profiles, or seller pages as official websites. A candidate MUST include an exact publicly listed business email supported by emailSourceUrl; never infer, guess, or fabricate an email. Phone is optional. Include source URLs and use null for absent optional data.`;
  try {
    const ai = new GoogleGenAI({ apiKey: env.geminiApiKey });
    const response = await ai.models.generateContent({ model: env.geminiModel, contents: prompt, config: { tools: [{ googleSearch: {} }, { urlContext: {} }], responseMimeType: 'application/json', responseJsonSchema: candidateSchema, temperature: 0.2 } });
    const parsed = JSON.parse(response.text || '{"candidates":[]}');
    return Array.isArray(parsed.candidates) ? parsed.candidates : [];
  } catch { throw new AppError('Lead discovery is temporarily unavailable. Please try again.', 503, 'GEMINI_UNAVAILABLE'); }
}

const variations = (input) => [`${input.category} e-commerce businesses in ${input.location}`, `online ${input.category} stores in ${input.location}`, `${input.category} brands with online shops in ${input.location}`, `${input.keywords || 'independent'} ${input.category} online brands ${input.location}`];
function prepareLead(candidate, input) {
  const website = normalizeUrl(candidate?.officialWebsite), domain = normalizeDomain(website), email = normalizeEmail(candidate?.email);
  if (!candidate?.isEcommerce || !candidate.businessName?.trim() || !website || !domain || !isSafePublicUrl(website) || !isValidPublicEmail(email) || !candidate.emailSourceUrl || !isSafePublicUrl(candidate.emailSourceUrl)) return null;
  return { businessName: candidate.businessName.trim().slice(0, 200), domain, website, email, phone: typeof candidate.phone === 'string' && candidate.phone.trim() ? candidate.phone.trim().slice(0, 80) : null, category: input.category, location: input.location, keywords: input.keywords, isEcommerce: true, websiteSourceUrl: isSafePublicUrl(candidate.websiteSourceUrl) ? normalizeUrl(candidate.websiteSourceUrl) : website, emailSourceUrl: normalizeUrl(candidate.emailSourceUrl), phoneSourceUrl: isSafePublicUrl(candidate.phoneSourceUrl) ? normalizeUrl(candidate.phoneSourceUrl) : null, discoverySource: 'gemini_google_search' };
}

export async function runDiscovery(jobId) {
  let job = await SearchJob.findById(jobId);
  if (!job || job.status === 'cancelled') return;
  const started = await SearchJob.findOneAndUpdate({ _id: jobId, status: 'queued' }, { $set: { status: 'running', startedAt: new Date() } }, { new: true });
  if (!started) return;
  const input = started.toObject(); let found = await Lead.countDocuments({ searchJobId: jobId, status: 'pending' }), duplicates = 0, rejected = 0;
  try {
    for (let attempt = 0; attempt < env.discoveryMaxAttempts && found < input.requestedCount; attempt += 1) {
      job = await SearchJob.findById(jobId).lean(); if (!job || job.status === 'cancelled') return;
      const candidates = await discoverWithGemini(input, variations(input)[attempt % variations(input).length]);
      for (const candidate of candidates) {
        if (found >= input.requestedCount) break;
        const lead = prepareLead(candidate, input);
        if (!lead) { rejected += 1; continue; }
        const existing = await Lead.findOne({ domain: lead.domain }).select('status searchJobId').lean();
        if (existing) { duplicates += 1; continue; }
        if ((await SearchJob.exists({ _id: jobId, status: { $ne: 'cancelled' } })) === null) return;
        try { await Lead.create({ ...lead, status: 'pending', searchJobId: jobId }); found += 1; } catch (error) { if (error?.code === 11000) duplicates += 1; else throw error; }
      }
      await SearchJob.updateOne({ _id: jobId }, { $set: { foundCount: found, duplicateCount: duplicates, rejectedCount: rejected } });
    }
    if ((await SearchJob.findById(jobId))?.status === 'cancelled') return;
    await SearchJob.updateOne({ _id: jobId }, { $set: { status: 'completed', foundCount: found, duplicateCount: duplicates, rejectedCount: rejected, completedAt: new Date() } });
    await SearchHistory.create({ category: input.category, location: input.location, keywords: input.keywords, requestedCount: input.requestedCount, foundCount: found });
  } catch (error) {
    logger.error('Discovery job failed', jobId, error.message);
    await SearchJob.updateOne({ _id: jobId, status: { $ne: 'cancelled' } }, { $set: { status: 'failed', errorMessage: 'Lead discovery is temporarily unavailable. Please try again.', completedAt: new Date(), foundCount: found, duplicateCount: duplicates, rejectedCount: rejected } });
  }
}
