import crypto from 'node:crypto';
import { env, Lead, ReceivedEmail, SentMailboxEmail } from '../models.js';
import { AppError, normalizeEmail } from '../utils.js';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const address = value => typeof value === 'string' ? (value.match(/<([^>]+)>/)?.[1] || value).trim() : '';
const addresses = value => (Array.isArray(value) ? value : value ? [value] : []).map(address).filter(Boolean).slice(0, 25);
const cleanSubject = subject => String(subject || '').replace(/^(\s*(re|fw|fwd)\s*:\s*)+/i, '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
export const messageToken = value => String(value || '').trim().replace(/^<|>$/g, '');
export const normalizedMessageId = value => { const token = messageToken(value); return token ? `<${token}>` : null; };
export const messageIds = values => [...new Set((Array.isArray(values) ? values : String(values || '').match(/<[^>]+>|[^\s]+/g) || []).map(normalizedMessageId).filter(Boolean))];
const participants = ({ fromEmail, from, to = [] }) => [...new Set([normalizeEmail(fromEmail || address(from)), ...addresses(to).map(normalizeEmail)].filter(Boolean))].sort();
const fallbackSignature = message => `${participants(message).join('|')}|${cleanSubject(message.subject)}`;

export function conversationFor(message, existing = []) {
  const ids = new Set(messageIds([message.messageId, message.inReplyTo, ...(message.references || [])]).map(messageToken));
  const linked = existing.find(item => messageIds([item.messageId, item.inReplyTo, ...(item.references || [])]).some(id => ids.has(messageToken(id))));
  if (linked) return linked.conversationId;
  const signature = fallbackSignature(message); const date = new Date(message.receivedAt || message.sentAt || Date.now());
  const candidates = [...new Set(existing.filter(item => item.fallbackSignature === signature && Math.abs(new Date(item.date) - date) < 14 * 86400000).map(item => item.conversationId))];
  return candidates.length === 1 ? candidates[0] : crypto.randomUUID();
}

export function verifyResendWebhook(headers, rawBody, secret = env.resendWebhookSecret) {
  const id = headers['svix-id']; const timestamp = headers['svix-timestamp']; const signature = headers['svix-signature'];
  if (!secret || !id || !timestamp || !signature || !Buffer.isBuffer(rawBody)) return false;
  const seconds = Number(timestamp); if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > 300) return false;
  let key; try { key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64'); } catch { return false; }
  const expected = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody.toString('utf8')}`).digest('base64');
  return signature.split(' ').some(part => { const actual = part.replace(/^v1,/, ''); try { return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected)); } catch { return false; } });
}
async function resendRequest(path, config = env) {
  if (!config.resendApiKey) throw new AppError('Missing RESEND_API_KEY.', 503, 'EMAIL_NOT_CONFIGURED');
  const response = await fetch(`https://api.resend.com${path}`, { headers: { Authorization: `Bearer ${config.resendApiKey}` } }); const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new AppError('Email provider is unavailable.', 502, 'EMAIL_PROVIDER_REJECTED'); return json.data || json;
}
export const receiveEmail = (id, config) => resendRequest(`/emails/receiving/${encodeURIComponent(id)}`, config);
export const listReceived = (limit, config) => resendRequest(`/emails/receiving?limit=${limit}`, config);
export function createRfcMessageId(from = env.emailFrom) { const domain = address(from).split('@')[1]?.toLowerCase().replace(/[^a-z0-9.-]/g, '') || 'mail.local'; return `<${crypto.randomUUID()}@${domain}>`; }
async function threadCandidates(ids) {
  if (!ids.length) return [];
  const filter = { $or: [{ messageId: { $in: ids } }, { inReplyTo: { $in: ids } }, { references: { $in: ids } }] };
  const fields = 'conversationId messageId inReplyTo references from fromEmail to subject receivedAt sentAt';
  const [received, sent] = await Promise.all([ReceivedEmail.find(filter).select(fields).lean(), SentMailboxEmail.find(filter).select(fields).lean()]);
  return [...received.map(x => ({ ...x, date: x.receivedAt })), ...sent.map(x => ({ ...x, date: x.sentAt }))];
}
function inboundDoc(email, { eventId, messageId, existing = [] } = {}) {
  const from = email.from || ''; const fromEmail = normalizeEmail(address(from)); const receivedAt = new Date(email.created_at || email.received_at || Date.now());
  const headers = email.headers || {}; const message = { from, fromEmail, to: addresses(email.to), subject: email.subject || '', messageId: normalizedMessageId(messageId || headers['message-id'] || email.message_id), inReplyTo: normalizedMessageId(headers['in-reply-to'] || email.in_reply_to), references: messageIds(headers.references || email.references), receivedAt };
  return { ...message, resendEmailId: String(email.id), webhookEventId: eventId || null, cc: addresses(email.cc), bcc: addresses(email.bcc), replyTo: addresses(email.reply_to), text: String(email.text || ''), html: String(email.html || ''), headers, attachments: (email.attachments || []).map(a => ({ filename: a.filename || a.name || 'Attachment', contentType: a.content_type || a.contentType || '', size: Number(a.size || 0) })), conversationId: conversationFor(message, existing.map(x => ({ ...x, fallbackSignature: fallbackSignature(x) }))) };
}
export async function persistReceived(email, options = {}) {
  if (!email?.id) throw new AppError('Received email is missing an id.', 400, 'INVALID_EMAIL');
  const resendEmailId = String(email.id); if (await ReceivedEmail.exists({ resendEmailId })) return { created: false };
  const ids = messageIds([options.messageId, email.headers?.['message-id'], email.message_id, email.headers?.['in-reply-to'], email.in_reply_to, ...messageIds(email.headers?.references || email.references)]);
  const doc = inboundDoc(email, { ...options, messageId: options.messageId, existing: await threadCandidates(ids) });
  const lead = doc.fromEmail ? await Lead.findOne({ emailNormalized: doc.fromEmail }).select('_id').lean() : null; if (lead) doc.leadId = lead._id;
  try { await ReceivedEmail.create(doc); return { created: true, conversationId: doc.conversationId }; } catch (error) { if (error?.code === 11000) return { created: false }; throw error; }
}
export function mailboxInput(body) {
  const to = addresses(body?.to).map(normalizeEmail); const cc = addresses(body?.cc).map(normalizeEmail); const bcc = addresses(body?.bcc).map(normalizeEmail);
  if (!to.length || [...to, ...cc, ...bcc].length > 25 || ![...to, ...cc, ...bcc].every(x => emailPattern.test(x))) throw new AppError('Enter one to 25 valid recipient addresses.', 400, 'VALIDATION_ERROR');
  const subject = String(body?.subject || '').trim(); const text = String(body?.text ?? body?.message ?? '').trim(); if (!subject || subject.length > 500 || !text || text.length > 20000) throw new AppError('Subject and message are required and must be within the allowed length.', 400, 'VALIDATION_ERROR'); return { to, cc, bcc, subject, text };
}
export async function sendMailboxEmail(input, thread = null) {
  if (!env.resendApiKey || !env.emailFrom) throw new AppError('Mailbox sending requires RESEND_API_KEY and EMAIL_FROM.', 503, 'EMAIL_NOT_CONFIGURED');
  const messageId = createRfcMessageId(env.emailFrom); const references = messageIds(thread?.references || []); const headers = { 'Message-ID': messageId, ...(thread?.inReplyTo ? { 'In-Reply-To': normalizedMessageId(thread.inReplyTo), References: references.join(' ') } : {}) };
  const payload = { from: env.emailFrom, ...input, ...(env.emailReplyTo ? { replyTo: env.emailReplyTo } : {}), headers };
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.resendApiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); const result = await response.json().catch(() => ({}));
  if (!response.ok || result.error) throw new AppError('The email provider rejected this message.', 502, 'EMAIL_PROVIDER_REJECTED'); const providerMessageId = result.id || result.data?.id || null;
  return SentMailboxEmail.create({ from: env.emailFrom, ...input, replyTo: env.emailReplyTo ? [env.emailReplyTo] : [], html: '', messageId, inReplyTo: thread?.inReplyTo ? normalizedMessageId(thread.inReplyTo) : null, references, sentAt: new Date(), conversationId: thread?.conversationId || crypto.randomUUID(), attachments: [], resendEmailId: providerMessageId, providerMessageId, source: 'direct' });
}
export async function persistCampaignMailboxEmail({ campaign, recipient, lead, subject, text, providerMessageId, messageId, sentAt }) {
  const rfcMessageId = normalizedMessageId(messageId) || createRfcMessageId(env.emailFrom);
  const record = { campaignId: campaign._id, campaignRecipientId: recipient._id, leadId: lead._id, source: 'campaign', from: env.emailFrom, to: [lead.email], cc: [], bcc: [], replyTo: env.emailReplyTo ? [env.emailReplyTo] : [], subject, text, html: '', headers: { 'Message-ID': rfcMessageId }, messageId: rfcMessageId, conversationId: crypto.randomUUID(), sentAt, attachments: [], resendEmailId: providerMessageId, providerMessageId };
  try { return await SentMailboxEmail.findOneAndUpdate({ campaignRecipientId: recipient._id }, { $setOnInsert: record }, { upsert: true, new: true }).lean(); } catch (error) { if (error?.code === 11000) return SentMailboxEmail.findOne({ campaignRecipientId: recipient._id }).lean(); throw error; }
}
