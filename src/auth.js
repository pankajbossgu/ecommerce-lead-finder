import crypto from 'node:crypto';

const SESSION_COOKIE = 'leadscout_session';
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

function credentialsConfig() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!username?.trim() || !password || !sessionSecret || Buffer.byteLength(sessionSecret) < 32) return null;
  return { username, password, sessionSecret };
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

export function verifyAdminCredentials(username, password) {
  if (!credentialsConfig()) return null;
  return username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD;
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
