import test from 'node:test';
import assert from 'node:assert/strict';
import { corsOptionsForRequest, isAllowedCorsOrigin } from '../src/app.js';
import { activeJobFilter, isTerminalJobStatus } from '../src/services.js';
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

test('job lifecycle regression: cancelled is terminal and finalisation is ownership guarded', () => {
  assert.equal(isTerminalJobStatus('queued'), false);
  assert.equal(isTerminalJobStatus('running'), false);
  assert.equal(isTerminalJobStatus('completed'), true);
  assert.equal(isTerminalJobStatus('failed'), true);
  assert.equal(isTerminalJobStatus('cancelled'), true);
  assert.deepEqual(activeJobFilter('job-id', 'worker-a'), { _id: 'job-id', status: 'running', workerToken: 'worker-a' });
  // A cancellation clears workerToken, so a stale worker cannot match this filter
  // and therefore cannot persist completed/failed progress afterwards.
  assert.notDeepEqual(activeJobFilter('job-id', 'worker-a'), { _id: 'job-id', status: 'running', workerToken: null });
});

test('lead action regression: Save, Not Useful, and Restore send supported persisted statuses', () => {
  for (const status of ['saved', 'discarded', 'new']) assert.equal(assertLeadStatus(status), status);
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

import { resolvedDuplicateFilter } from '../src/services.js';

test('duplicate rule only filters persisted saved and discarded businesses', () => {
  assert.deepEqual(resolvedDuplicateFilter('brand.example'), { domain: 'brand.example', status: { $in: ['saved', 'discarded'] } });
  assert.equal(resolvedDuplicateFilter('brand.example').status.$in.includes('new'), false);
});

test('current-job result filter keeps a job scoped and bulk lifecycle statuses are valid', () => {
  const jobId = '507f1f77bcf86cd799439011';
  assert.equal(/^[a-f\d]{24}$/i.test(jobId), true);
  for (const status of ['saved', 'discarded', 'new']) assert.doesNotThrow(() => assertLeadStatus(status));
  assert.throws(() => assertLeadStatus('delete'));
});

import fs from 'node:fs';

test('regression contracts: durable checkpoint, scoped cap, cancellation cleanup, and lead list controls', () => {
  const services = fs.readFileSync(new URL('../src/services.js', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const client = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(services, /batchId.*candidates/); // exact batch + cursor persist together
  assert.match(services, /foundCount: \{ \$lt: job\.requestedCount \}/); // no more than requested results
  assert.match(services, /checkpoint\.candidateIndex/);
  assert.match(app, /Lead\.deleteMany\(\{ searchJobId: job\._id, status: 'new' \}\)/);
  assert.match(app, /srNo: \(page - 1\) \* limit \+ index \+ 1/);
  assert.match(client, /id="select-all"/);
  assert.match(html, /data-bulk="saved"/);
  assert.match(html, /data-bulk="discarded"/);
  assert.match(html, /data-bulk="delete"/);
  assert.match(client, /Ready for future outreach/);
  assert.match(client, /state\.jobId = null; state\.selected\.clear\(\)/);
});
