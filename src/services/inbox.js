import crypto from 'node:crypto';
import { env, Lead, ReceivedEmail, SentMailboxEmail } from '../models.js';
import { AppError, normalizeEmail } from '../utils.js';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const address = value => typeof value === 'string' ? (value.match(/<([^>]+)>/)?.[1] || value).trim() : '';
const addresses = value => (Array.isArray(value) ? value : value ? [value] : []).map(address).filter(Boolean).slice(0, 25);
const cleanSubject = subject => String(subject || '').replace(/^(\s*(re|fw|fwd)\s*:\s*)+/i, '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
const messageToken = value => String(value || '').trim().replace(/^<|>$/g, '');
const participants = ({ fromEmail, from, to = [] }) => [...new Set([normalizeEmail(fromEmail || address(from)), ...addresses(to).map(normalizeEmail)].filter(Boolean))].sort();
export function conversationFor(message, existing = []) {
  const ids = new Set([messageToken(message.messageId), messageToken(message.inReplyTo), ...(message.references || []).map(messageToken)].filter(Boolean));
  const linked = existing.find(item => [item.messageId, item.inReplyTo, ...(item.references || [])].map(messageToken).some(id => ids.has(id)));
  if (linked) return linked.conversationId;
  // Fallback is deliberately scoped by sender/recipients and subject. It is used
  // only when there is exactly one recent compatible conversation.
  const signature = `${participants(message).join('|')}|${cleanSubject(message.subject)}`;
  const candidates = existing.filter(item => item.fallbackSignature === signature && Math.abs(new Date(item.date) - new Date(message.receivedAt || message.sentAt || Date.now())) < 14 * 86400000);
  return candidates.length === 1 ? candidates[0].conversationId : crypto.randomUUID();
}
export function verifyResendWebhook(headers, rawBody, secret = env.resendWebhookSecret) {
  const id = headers['svix-id']; const timestamp = headers['svix-timestamp']; const signature = headers['svix-signature'];
  if (!secret || !id || !timestamp || !signature || !Buffer.isBuffer(rawBody)) return false;
  const seconds = Number(timestamp); if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64'); const signed = `${id}.${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', key).update(signed).digest('base64');
  return signature.split(' ').some(part => { const actual = part.replace(/^v1,/, ''); try { return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected)); } catch { return false; } });
}
async function resendRequest(path, config = env) {
  if (!config.resendApiKey) throw new AppError('Missing RESEND_API_KEY.', 503, 'EMAIL_NOT_CONFIGURED');
  const response = await fetch(`https://api.resend.com${path}`, { headers: { Authorization: `Bearer ${config.resendApiKey}` } });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new AppError('Email provider is unavailable.', 502, 'EMAIL_PROVIDER_REJECTED');
  return json.data || json;
}
export const receiveEmail = (id, config) => resendRequest(`/emails/receiving/${encodeURIComponent(id)}`, config);
export const listReceived = (limit, config) => resendRequest(`/emails/receiving?limit=${limit}`, config);
function inboundDoc(email, { eventId, existing = [] } = {}) {
  const from = email.from || ''; const fromEmail = normalizeEmail(address(from)); const receivedAt = new Date(email.created_at || email.received_at || Date.now());
  const message = { from, fromEmail, to: addresses(email.to), subject: email.subject || '', messageId: email.headers?.['message-id'] || email.message_id, inReplyTo: email.headers?.['in-reply-to'] || email.in_reply_to, references: String(email.headers?.references || email.references || '').split(/\s+/).filter(Boolean), receivedAt };
  return { ...message, resendEmailId: String(email.id), webhookEventId: eventId || null, cc: addresses(email.cc), bcc: addresses(email.bcc), replyTo: addresses(email.reply_to), text: String(email.text || ''), html: String(email.html || ''), headers: email.headers || {}, attachments: (email.attachments || []).map(a => ({ filename: a.filename || a.name || 'Attachment', contentType: a.content_type || a.contentType || '', size: Number(a.size || 0) })), conversationId: conversationFor(message, existing) };
}
export async function persistReceived(email, options = {}) {
  if (!email?.id) throw new AppError('Received email is missing an id.', 400, 'INVALID_EMAIL');
  if (await ReceivedEmail.exists({ resendEmailId: String(email.id) })) return { created: false };
  const existing = await ReceivedEmail.find({ $or: [{ messageId: { $in: [email.headers?.['in-reply-to'], email.in_reply_to].filter(Boolean) } }, { inReplyTo: { $in: [email.headers?.['message-id'], email.message_id].filter(Boolean) } }] }).select('conversationId messageId inReplyTo references from fromEmail to subject receivedAt').lean();
  const doc = inboundDoc(email, { ...options, existing: existing.map(x => ({ ...x, date: x.receivedAt, fallbackSignature: `${participants(x).join('|')}|${cleanSubject(x.subject)}` })) });
  const lead = doc.fromEmail ? await Lead.findOne({ emailNormalized: doc.fromEmail }).select('_id').lean() : null;
  if (lead) doc.leadId = lead._id;
  try { await ReceivedEmail.create(doc); return { created: true, conversationId: doc.conversationId }; } catch (error) { if (error?.code === 11000) return { created: false }; throw error; }
}
export function mailboxInput(body) {
  const to = addresses(body?.to).map(normalizeEmail); const cc = addresses(body?.cc).map(normalizeEmail); const bcc = addresses(body?.bcc).map(normalizeEmail);
  if (!to.length || [...to, ...cc, ...bcc].length > 25 || ![...to, ...cc, ...bcc].every(x => emailPattern.test(x))) throw new AppError('Enter one to 25 valid recipient addresses.', 400, 'VALIDATION_ERROR');
  const subject = String(body?.subject || '').trim(); const text = String(body?.text ?? body?.message ?? '').trim();
  if (!subject || subject.length > 500 || !text || text.length > 20000) throw new AppError('Subject and message are required and must be within the allowed length.', 400, 'VALIDATION_ERROR');
  return { to, cc, bcc, subject, text };
}
export async function sendMailboxEmail(input, thread = null) {
  if (!env.resendApiKey || !env.emailFrom) throw new AppError('Mailbox sending requires RESEND_API_KEY and EMAIL_FROM.', 503, 'EMAIL_NOT_CONFIGURED');
  const payload = { from: env.emailFrom, ...input, ...(env.emailReplyTo ? { replyTo: env.emailReplyTo } : {}), ...(thread?.inReplyTo ? { headers: { 'In-Reply-To': thread.inReplyTo, References: thread.references.join(' ') } } : {}) };
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.resendApiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); const result = await response.json().catch(() => ({}));
  if (!response.ok || result.error) throw new AppError('The email provider rejected this message.', 502, 'EMAIL_PROVIDER_REJECTED');
  const messageId = result.id || result.data?.id || null; const sentAt = new Date(); const base = { from: env.emailFrom, ...input, replyTo: env.emailReplyTo ? [env.emailReplyTo] : [], html: '', messageId, inReplyTo: thread?.inReplyTo || null, references: thread?.references || [], sentAt, conversationId: thread?.conversationId || crypto.randomUUID(), attachments: [] };
  const saved = await SentMailboxEmail.create({ ...base, resendEmailId: messageId, providerMessageId: messageId }); return saved;
}
