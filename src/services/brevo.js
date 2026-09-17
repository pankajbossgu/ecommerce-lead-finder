import { env } from '../models.js';
import { AppError } from '../utils.js';

const sender = () => {
  const match = env.brevoEmailFrom.match(/^(.*?)\s*<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>$/);
  return match ? { name: match[1].trim() || 'SmartLocator', email: match[2] } : { name: 'SmartLocator', email: 'mail@smartlocator.online' };
};
export async function sendBrevoEmail({ to, cc = [], bcc = [], subject, text, headers }) {
  if (!env.brevoApiKey) throw new AppError('Missing BREVO_API_KEY.', 503, 'EMAIL_NOT_CONFIGURED');
  const response = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': env.brevoApiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ sender: sender(), to: to.map(email => ({ email })), ...(cc.length ? { cc: cc.map(email => ({ email })) } : {}), ...(bcc.length ? { bcc: bcc.map(email => ({ email })) } : {}), subject, textContent: text, ...(headers ? { headers } : {}) }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new AppError(response.status === 429 || response.status >= 500 ? 'Email provider is temporarily unavailable. Retry this batch later.' : 'The email provider rejected this message.', 502, response.status === 429 || response.status >= 500 ? 'EMAIL_PROVIDER_TRANSIENT' : 'EMAIL_PROVIDER_REJECTED');
  return { id: result.messageId || null, from: env.brevoEmailFrom };
}
export async function sendBrevoEmailBatch(messages) {
  return Promise.all(messages.map(async message => {
    try { const result = await sendBrevoEmail({ ...message, to: [message.to] }); return { ok: true, id: result.id }; } catch (error) { return { ok: false, code: error.code || 'EMAIL_PROVIDER_REJECTED', reason: error.message || 'The email provider rejected this request.' }; }
  }));
}
