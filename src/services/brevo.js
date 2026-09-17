import { env } from '../models.js';
import { AppError } from '../utils.js';
import { emailConfiguration, resolveEmailSender } from './email.js';

export async function sendBrevoEmail({ to, cc = [], bcc = [], subject, text, headers, replyTo }, config = env) {
  const readiness = emailConfiguration(config, 'brevo'); if (!readiness.ready) throw new AppError(readiness.reason, 503, readiness.code);
  const sender = resolveEmailSender('brevo', config);
  const response = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': config.brevoApiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ sender: { name: sender.name, email: sender.email }, to: to.map(email => ({ email })), ...(cc.length ? { cc: cc.map(email => ({ email })) } : {}), ...(bcc.length ? { bcc: bcc.map(email => ({ email })) } : {}), ...(replyTo ? { replyTo: { email: replyTo } } : {}), subject, textContent: text, ...(headers ? { headers } : {}) }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new AppError(response.status === 429 || response.status >= 500 ? 'Email provider is temporarily unavailable. Retry this batch later.' : 'The email provider rejected this message.', 502, response.status === 429 || response.status >= 500 ? 'EMAIL_PROVIDER_TRANSIENT' : 'EMAIL_PROVIDER_REJECTED');
  return { id: result.messageId || null, from: sender.from };
}
export async function sendBrevoEmailBatch(messages, config = env, request = fetch) {
  if (messages.length > 100) throw new AppError('Brevo campaign batches cannot contain more than 100 recipients.', 400, 'EMAIL_BATCH_TOO_LARGE');
  if (!messages.length) return [];
  const readiness = emailConfiguration(config, 'brevo'); if (!readiness.ready) throw new AppError(readiness.reason, 503, readiness.code);
  const sender = resolveEmailSender('brevo', config);
  // Brevo accepts per-recipient content as messageVersions in one transactional
  // email request and returns an id for each accepted message version.
  let response;
  try {
    response = await request('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': config.brevoApiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ sender: { name: sender.name, email: sender.email }, messageVersions: messages.map(message => ({ to: [{ email: message.to }], subject: message.subject, textContent: message.text, ...(message.replyTo ? { replyTo: { email: message.replyTo } } : {}) })) }) });
  } catch {
    // Brevo's batch endpoint has no documented idempotency key. A transport
    // error therefore cannot establish whether Brevo accepted this request.
    throw new AppError('The Brevo batch request outcome is unknown. Do not automatically resend this batch.', 502, 'EMAIL_PROVIDER_AMBIGUOUS');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new AppError(response.status === 429 || response.status >= 500 ? 'Email provider is temporarily unavailable. Retry this batch later.' : 'The email provider rejected this message.', 502, response.status === 429 || response.status >= 500 ? 'EMAIL_PROVIDER_TRANSIENT' : 'EMAIL_PROVIDER_REJECTED');
  return messages.map((_message, index) => ({ ok: true, id: result.messageIds?.[index] || null }));
}
