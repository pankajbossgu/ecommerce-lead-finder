import { env } from '../models.js';
import { AppError } from '../utils.js';

export async function sendEmail({ to, subject, text, idempotencyKey }) {
  if (!env.resendApiKey || !env.emailFrom) throw new AppError('Email sending is not configured. Add RESEND_API_KEY and EMAIL_FROM on the server.', 503, 'EMAIL_NOT_CONFIGURED');
  let Resend;
  try { ({ Resend } = await import('resend')); } catch { throw new AppError('Email sending is temporarily unavailable.', 503, 'EMAIL_UNAVAILABLE'); }
  const resend = new Resend(env.resendApiKey);
  const response = await resend.emails.send({ from: env.emailFrom, to: [to], subject, text, headers: { 'Idempotency-Key': idempotencyKey } });
  if (response.error) throw new AppError('The email provider could not accept this message.', 502, 'EMAIL_PROVIDER_ERROR');
  return response.data?.id || null;
}
