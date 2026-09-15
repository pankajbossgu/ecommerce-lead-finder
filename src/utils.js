export class AppError extends Error {
  constructor(message, status = 500, code = 'INTERNAL_ERROR') {
    super(message); this.status = status; this.code = code;
  }
}
export const badRequest = (message) => new AppError(message, 400, 'VALIDATION_ERROR');
export const logger = {
  info: (...args) => console.info('[info]', ...args),
  warn: (...args) => console.warn('[warn]', ...args),
  error: (...args) => console.error('[error]', ...args)
};

const PLACEHOLDER_EMAILS = new Set(['example@example.com', 'email@example.com', 'test@example.com', 'your@email.com']);
export function normalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const raw = value.trim();
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    url.protocol = 'https:'; url.hostname = url.hostname.toLowerCase();
    url.username = ''; url.password = ''; url.hash = ''; url.search = '';
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
    return url.toString();
  } catch { return null; }
}
export function normalizeDomain(value) {
  const url = normalizeUrl(value);
  if (!url) return null;
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
}
export const normalizeEmail = (value) => typeof value === 'string' ? value.trim().toLowerCase() : null;
// Keep identity keys deliberately small and deterministic.  They are used for
// matching only; the original, user-facing name remains untouched.
export function normalizeBusinessName(value) {
  if (typeof value !== 'string') return null;
  const name = value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  if (!name) return null;
  return name.replace(/\b(?:private\s+limited|pvt\.?\s*ltd\.?|private|limited|ltd\.?)\b/g, ' ').replace(/\s+/g, ' ').trim() || null;
}
export function normalizeSocialProfileUrl(value) {
  const url = normalizeUrl(value);
  if (!url) return null;
  const parsed = new URL(url); const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  if (!['instagram.com', 'facebook.com', 'linkedin.com'].includes(host)) return null;
  const path = parsed.pathname.replace(/\/+$/, '');
  // A host alone is not a profile and must never become a cross-business key.
  return path && path !== '/' ? `${host}${path.toLowerCase()}` : null;
}
export function isValidPublicEmail(value) {
  const email = normalizeEmail(value);
  if (!email || email.length > 254 || PLACEHOLDER_EMAILS.has(email) || /@(example\.(com|org|net)|invalid|test)$/i.test(email)) return false;
  if (/^(?:noreply|no-reply|example|test)@/i.test(email)) return false;
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(email);
}
export function normalizePhone(value) {
  if (typeof value !== 'string') return null;
  const phone = value.trim().replace(/\s+/g, ' ');
  if (!phone || phone.length > 80 || !/^[+()\d.\- xext]+$/i.test(phone)) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? phone : null;
}
export function normalizePhoneIdentity(value) {
  const phone = normalizePhone(value);
  return phone ? phone.replace(/\D/g, '') : null;
}
export function isSafePublicUrl(value) {
  const url = normalizeUrl(value); if (!url) return false;
  const host = new URL(url).hostname;
  return host !== 'localhost' && host !== '::1' && !/^127\./.test(host) && !/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
}
const allowedCounts = new Set([20, 30, 40, 50, 60, 70, 80, 90, 100]);
export const discoveryModes = new Set(['hybrid', 'website', 'social']);
const clean = (value, max, name, required = false) => {
  if (typeof value !== 'string') { if (required) throw badRequest(`${name} is required`); return ''; }
  const result = value.trim().replace(/\s+/g, ' ');
  if (required && !result) throw badRequest(`${name} is required`);
  if (result.length > max) throw badRequest(`${name} must be ${max} characters or fewer`);
  return result;
};
export function parseDiscoveryInput(body) {
  const requestedCount = Number(body.requestedCount);
  if (!Number.isInteger(requestedCount) || !allowedCounts.has(requestedCount)) throw badRequest('Number of leads must be one of 20 through 100 in increments of 10');
  const mode = body?.mode == null || body.mode === '' ? 'hybrid' : body.mode;
  if (typeof mode !== 'string' || !discoveryModes.has(mode)) throw badRequest('Discovery source must be hybrid, website, or social');
  return { category: clean(body.category, 100, 'Category', true), location: clean(body.location, 100, 'Location', true), keywords: clean(body.keywords, 200, 'Keywords'), requestedCount, mode };
}
export function parsePagination(query) {
  const page = Number(query.page ?? 1), limit = Number(query.limit ?? 25);
  if (!Number.isInteger(page) || page < 1) throw badRequest('page must be a positive integer');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw badRequest('limit must be an integer between 1 and 100');
  return { page, limit };
}
export function assertLeadStatus(status) {
  if (!['new', 'saved', 'discarded'].includes(status)) throw badRequest('Status must be new, saved, or discarded');
  return status;
}

export function parseDateRange(query, fieldName = 'date') {
  const parse = (value, label) => {
    if (value === undefined || value === '') return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw badRequest(`${label} must be a valid YYYY-MM-DD date`);
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw badRequest(`${label} must be a valid date`);
    return date;
  };
  const from = parse(query.from, 'From date'), toDay = parse(query.to, 'To date');
  if (from && toDay && toDay < from) throw badRequest('To date must be greater than or equal to From date');
  const to = toDay ? new Date(toDay.getTime() + 86400000) : null;
  return { from, to, fieldName };
}
export function applyDateRange(filter, range) {
  if (range.from || range.to) filter[range.fieldName] = { ...(range.from ? { $gte: range.from } : {}), ...(range.to ? { $lt: range.to } : {}) };
  return filter;
}
