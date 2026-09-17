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
export async function sendBrevoEmailBatch(messages, config = env) { return Promise.all(messages.map(async message => { try { const result = await sendBrevoEmail({ ...message, to: [message.to] }, config); return { ok: true, id: result.id }; } catch (error) { return { ok: false, code: error.code || 'EMAIL_PROVIDER_REJECTED', reason: error.message || 'The email provider rejected this request.' }; } })); }
