import { env } from '../models.js';
import { AppError } from '../utils.js';

const senderPattern = /^(?:[^<>\r\n]+\s+)?<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>$|^([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)$/;
export function emailConfiguration(config = env) {
  const missing = [];
  if (!config.resendApiKey) missing.push('RESEND_API_KEY');
  if (!config.emailFrom) missing.push('EMAIL_FROM');
  if (missing.length) return { ready: false, code: 'EMAIL_NOT_CONFIGURED', reason: `Missing ${missing.join(' and ')}.`, missing };
  if (!senderPattern.test(config.emailFrom.trim())) return { ready: false, code: 'EMAIL_INVALID_SENDER', reason: 'EMAIL_FROM must be a valid sender address, optionally in Name <address> format.', missing: [] };
  return { ready: true, code: 'EMAIL_READY', reason: null, missing: [] };
}
function providerFailure(error) {
  const text = String(error?.message || error?.name || 'Email provider rejected the request').slice(0, 300);
  const lower = text.toLowerCase();
  const code = /rate|timeout|temporar|network/.test(lower) ? 'EMAIL_PROVIDER_TRANSIENT' : /sender|domain|from/.test(lower) ? 'EMAIL_INVALID_SENDER' : 'EMAIL_PROVIDER_REJECTED';
  return { code, reason: code === 'EMAIL_PROVIDER_TRANSIENT' ? 'Email provider is temporarily unavailable. Retry this batch later.' : code === 'EMAIL_INVALID_SENDER' ? 'The configured sender or domain was rejected by the email provider.' : 'The email provider rejected this request.' };
}
export function normalizeBatchResponse(response, count) {
  if (response?.error) throw new AppError(providerFailure(response.error).reason, 502, providerFailure(response.error).code);
  const data = response?.data?.data || response?.data || [];
  const rows = Array.isArray(data) ? data : [];
  return Array.from({ length: count }, (_v, index) => {
    const item = rows[index];
    if (!item) return { ok: false, code: 'EMAIL_PROVIDER_PARTIAL_FAILURE', reason: 'The provider did not accept this recipient.' };
    if (item.error || item.status === 'error') { const failure = providerFailure(item.error || item); return { ok: false, code: failure.code, reason: failure.reason }; }
    return { ok: true, id: item.id || item.messageId || null };
  });
}
export async function sendEmailBatch(messages, idempotencyKey, config = env, resendFactory) {
  const readiness = emailConfiguration(config);
  if (!readiness.ready) throw new AppError(readiness.reason, 503, readiness.code);
  const { Resend } = resendFactory ? { Resend: resendFactory } : await import('resend');
  const resend = new Resend(config.resendApiKey);
  try {
    const response = await resend.batch.send(messages.map(message => ({ from: config.emailFrom, to: [message.to], subject: message.subject, text: message.text, ...(message.headers ? { headers: message.headers } : {}) })), { idempotencyKey });
    return normalizeBatchResponse(response, messages.length);
  } catch (error) {
    if (error instanceof AppError) throw error;
    const failure = providerFailure(error);
    throw new AppError(failure.reason, 502, failure.code);
  }
}
