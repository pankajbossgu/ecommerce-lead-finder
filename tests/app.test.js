import test from 'node:test';
import assert from 'node:assert/strict';
import { corsOptionsForRequest, isAllowedCorsOrigin } from '../src/app.js';
import { assertLeadStatus, isValidPublicEmail, normalizeDomain, normalizeEmail, normalizeUrl, parseDiscoveryInput, parsePagination } from '../src/utils.js';

test('normalizes domains without losing meaningful subdomains', () => {
  assert.equal(normalizeDomain('HTTPS://WWW.Example.COM/Test?utm_source=x'), 'example.com');
  assert.equal(normalizeDomain('http://example.com:80/contact'), 'example.com');
  assert.equal(normalizeDomain('shop.example.com/path'), 'shop.example.com');
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
});
test('normalizes and validates public business email addresses', () => {
  assert.equal(normalizeEmail('  Sales@Example.CO.UK '), 'sales@example.co.uk');
  assert.equal(isValidPublicEmail('sales@brand.co.uk'), true);
  assert.equal(isValidPublicEmail('hello@example.com'), false);
  assert.equal(isValidPublicEmail('not-an-email'), false);
});
test('validates discovery counts, pagination, and lead status lifecycle', () => {
  assert.deepEqual(parseDiscoveryInput({ category: 'Fashion', location: 'India', keywords: '', requestedCount: '50' }), { category: 'Fashion', location: 'India', keywords: '', requestedCount: 50 });
  assert.throws(() => parseDiscoveryInput({ category: 'Fashion', location: 'India', requestedCount: '25' }));
  assert.deepEqual(parsePagination({ page: '2', limit: '50' }), { page: 2, limit: 50 });
  assert.throws(() => parsePagination({ limit: '101' }));
  assert.equal(assertLeadStatus('saved'), 'saved'); assert.throws(() => assertLeadStatus('campaign'));
});

const requestFor = ({ host = 'finder.vercel.app', protocol = 'https' } = {}) => ({
  protocol,
  get(header) {
    return { host, 'x-forwarded-proto': protocol }[header];
  }
});

test('allows the production deployment origin without APP_ORIGIN', () => {
  assert.equal(isAllowedCorsOrigin('https://finder.vercel.app', requestFor(), []), true);
});

test('allows an explicitly configured external APP_ORIGIN', () => {
  assert.equal(isAllowedCorsOrigin('https://app.example.com', requestFor(), ['https://app.example.com']), true);
});

test('rejects unknown external origins', () => {
  const req = requestFor();
  assert.equal(isAllowedCorsOrigin('https://untrusted.example.com', req, []), false);

  corsOptionsForRequest(req).origin('https://untrusted.example.com', (error) => {
    assert.match(error.message, /Origin not allowed by CORS/);
  });
});

test('allows requests without an Origin header', () => {
  assert.equal(isAllowedCorsOrigin(undefined, requestFor(), []), true);
});
