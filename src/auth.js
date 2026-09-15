import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = 'leadscout_session';
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
const passwordHashPattern = /^scrypt\$([^$]+)\$([A-Za-z0-9_-]+)$/;

function credentialsConfig() {
  const username = process.env.ADMIN_USERNAME;
  const passwordHash = process.env.ADMIN_PASSWORD_HASH;
  const sessionSecret = process.env.SESSION_SECRET;
  const hashMatch = typeof passwordHash === 'string' ? passwordHashPattern.exec(passwordHash) : null;
  if (!username?.trim() || !hashMatch || !sessionSecret || Buffer.byteLength(sessionSecret) < 32) return null;
  return { username, salt: hashMatch[1], derivedKey: hashMatch[2], sessionSecret };
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim().split(/=(.*)/s)).filter(([key]) => key));
}

function sessionSignature(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function sessionFromRequest(req) {
  const config = credentialsConfig();
  if (!config) return null;
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token || token.length > 2048) return null;
  const [payload, signature, ...extra] = token.split('.');
  if (!payload || !signature || extra.length || !safeEqual(signature, sessionSignature(payload, config.sessionSecret))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return session.authenticated === true && Number.isSafeInteger(session.issuedAt) && Number.isSafeInteger(session.expiresAt) && session.expiresAt > Date.now() && session.expiresAt > session.issuedAt ? session : null;
  } catch {
    return null;
  }
}

function cookieOptions(maxAge = SESSION_LIFETIME_MS) {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge };
}

function setNoStore(res) { res.set('Cache-Control', 'no-store'); }
function configurationError(res) { setNoStore(res); return res.status(500).json({ error: 'Authentication is not configured.', code: 'AUTH_CONFIGURATION_ERROR' }); }

export async function verifyAdminCredentials(username, password) {
  const config = credentialsConfig();
  if (!config) return null;
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password || username.length > 256 || password.length > 1024) return false;
  const candidateKey = await scrypt(password, config.salt, 64);
  return safeEqual(username, config.username) && safeEqual(candidateKey.toString('base64url'), config.derivedKey);
}

export function requireAuth(req, res, next) {
  if (!credentialsConfig()) return configurationError(res);
  const session = sessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
  req.auth = session;
  return next();
}

export function requireDashboardAuth(req, res, next) {
  if (!sessionFromRequest(req)) return res.redirect(302, '/login');
  return next();
}

export function authRoutes(app, loginRateLimit) {
  app.post('/api/auth/login', loginRateLimit, async (req, res, next) => {
    try {
      const valid = await verifyAdminCredentials(req.body?.username, req.body?.password);
      if (valid === null) return configurationError(res);
      if (!valid) return res.status(401).json({ error: 'Invalid username or password.', code: 'INVALID_CREDENTIALS' });
      const config = credentialsConfig();
      const issuedAt = Date.now();
      const payload = Buffer.from(JSON.stringify({ authenticated: true, issuedAt, expiresAt: issuedAt + SESSION_LIFETIME_MS })).toString('base64url');
      res.cookie(SESSION_COOKIE, `${payload}.${sessionSignature(payload, config.sessionSecret)}`, cookieOptions());
      setNoStore(res);
      return res.json({ authenticated: true });
    } catch (error) { return next(error); }
  });
  app.get('/api/auth/session', (req, res) => { setNoStore(res); return res.json({ authenticated: Boolean(sessionFromRequest(req)) }); });
  app.post('/api/auth/logout', (_req, res) => { res.clearCookie(SESSION_COOKIE, cookieOptions(0)); setNoStore(res); return res.json({ authenticated: false }); });
}

export function isAuthenticated(req) { return Boolean(sessionFromRequest(req)); }
