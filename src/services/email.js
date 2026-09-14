import { env } from '../models.js';
import { AppError } from '../utils.js';

export async function sendEmailBatch(messages, idempotencyKey) {
  if (!env.resendApiKey || !env.emailFrom) throw new AppError('Email sending is not configured. Add RESEND_API_KEY and EMAIL_FROM on the server.', 503, 'EMAIL_NOT_CONFIGURED');
  const { Resend } = await import('resend');
  const resend = new Resend(env.resendApiKey);
  // Resend's batch endpoint accepts at most 100 messages. The request-level
  // idempotency key is retained with the claimed recipients for safe retries.
  const response = await resend.batch.send(messages.map(message => ({ from: env.emailFrom, to: [message.to], subject: message.subject, text: message.text })), { idempotencyKey });
  if (response.error) throw new AppError('The email provider could not accept this message.', 502, 'EMAIL_PROVIDER_ERROR');
  return response.data?.data || response.data || [];
}
