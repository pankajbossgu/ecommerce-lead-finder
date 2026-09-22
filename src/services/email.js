import { env } from '../models.js';
import { AppError } from '../utils.js';

export const EMAIL_PROVIDERS = Object.freeze(['resend', 'brevo']);
const emailPattern = /^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/;
const safeName = name => String(name || '').trim().replace(/[<>\r\n]/g, '');
const senderEmail = value => String(value || '').trim().match(/^(?:[^<>\r\n]+\s+)?<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>$|^([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)$/)?.slice(1).find(Boolean)?.toLowerCase() || '';

export function validateEmailProvider(value) {
  const provider = value || 'resend';
  if (!EMAIL_PROVIDERS.includes(provider)) throw new AppError('Choose Resend or Brevo.', 400, 'VALIDATION_ERROR');
  return provider;
}
export function resolveEmailSender(provider, config = env) {
  const selected = validateEmailProvider(provider);
  // EMAIL_FROM remains a Resend-only migration fallback for existing deployments.
  const email = senderEmail(selected === 'resend' ? (config.resendEmailFrom || config.emailFrom) : config.brevoEmailFrom);
  const name = safeName(config.emailName || 'SmartLocator');
  if (!emailPattern.test(email)) throw new AppError(`${selected === 'resend' ? 'RESEND_EMAIL_FROM (or legacy EMAIL_FROM)' : 'BREVO_EMAIL_FROM'} must be a valid email address.`, 503, 'EMAIL_INVALID_SENDER');
  return { provider: selected, name, email, from: `${name} <${email}>` };
}
export function emailConfiguration(config = env, provider = 'resend') {
  const selected = validateEmailProvider(provider); const missing = [];
  if (selected === 'resend' && !config.resendApiKey) missing.push('RESEND_API_KEY');
  if (selected === 'brevo' && !config.brevoApiKey) missing.push('BREVO_API_KEY');
  const configuredSender = selected === 'resend' ? (config.resendEmailFrom || config.emailFrom) : config.brevoEmailFrom;
  if (!configuredSender) missing.push(selected === 'resend' ? 'RESEND_EMAIL_FROM' : 'BREVO_EMAIL_FROM');
  if (missing.length) return { ready: false, code: 'EMAIL_NOT_CONFIGURED', reason: `Missing ${missing.join(' and ')}.`, missing };
  try { resolveEmailSender(selected, config); } catch (error) { return { ready: false, code: error.code || 'EMAIL_INVALID_SENDER', reason: error.message, missing: [] }; }
  return { ready: true, code: 'EMAIL_READY', reason: null, missing: [] };
}
function providerFailure(error) {
  const text = String(error?.message || error?.name || 'Email provider rejected the request').slice(0, 300); const lower = text.toLowerCase();
  const code = /rate|timeout|temporar|network/.test(lower) ? 'EMAIL_PROVIDER_TRANSIENT' : /sender|domain|from/.test(lower) ? 'EMAIL_INVALID_SENDER' : 'EMAIL_PROVIDER_REJECTED';
  return { code, reason: code === 'EMAIL_PROVIDER_TRANSIENT' ? 'Email provider is temporarily unavailable. Retry this batch later.' : code === 'EMAIL_INVALID_SENDER' ? 'The configured sender or domain was rejected by the email provider.' : 'The email provider rejected this request.' };
}
export function normalizeBatchResponse(response, count) {
  if (response?.error) throw new AppError(providerFailure(response.error).reason, 502, providerFailure(response.error).code);
  const data = response?.data?.data || response?.data || []; const rows = Array.isArray(data) ? data : [];
  return Array.from({ length: count }, (_v, index) => { const item = rows[index]; if (!item) return { ok: false, code: 'EMAIL_PROVIDER_PARTIAL_FAILURE', reason: 'The provider did not accept this recipient.' }; if (item.error || item.status === 'error') { const failure = providerFailure(item.error || item); return { ok: false, code: failure.code, reason: failure.reason }; } return { ok: true, id: item.id || item.messageId || null }; });
}
export async function sendEmailBatch(messages, idempotencyKey, config = env, resendFactory) {
  const readiness = emailConfiguration(config, 'resend'); if (!readiness.ready) throw new AppError(readiness.reason, 503, readiness.code);
  const sender = resolveEmailSender('resend', config); const { Resend } = resendFactory ? { Resend: resendFactory } : await import('resend'); const resend = new Resend(config.resendApiKey);
  try { const response = await resend.batch.send(messages.map(message => ({ from: sender.from, to: [message.to], subject: message.subject, text: message.text, ...(message.html ? { html: message.html } : {}), ...(message.replyTo ? { replyTo: message.replyTo } : {}), ...(message.headers ? { headers: message.headers } : {}) })), { idempotencyKey }); return normalizeBatchResponse(response, messages.length); } catch (error) { if (error instanceof AppError) throw error; const failure = providerFailure(error); throw new AppError(failure.reason, 502, failure.code); }
}
