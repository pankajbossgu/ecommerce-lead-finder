import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import mongoose from 'mongoose';
import { Lead } from '../src/models.js';
import { createSeenDomainTracker } from '../src/services.js';
import { assertLeadStatus, assertPermanentLeadStatus, uniqueObjectIds, isValidPublicEmail, normalizeDomain, normalizeEmail, normalizeUrl, parseDiscoveryInput, parsePagination } from '../src/utils.js';

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
  assert.equal(assertLeadStatus('pending'), 'pending'); assert.equal(assertLeadStatus('saved'), 'saved'); assert.equal(assertLeadStatus('discarded'), 'discarded'); assert.throws(() => assertLeadStatus('new')); assert.equal(assertPermanentLeadStatus('saved'), 'saved'); assert.throws(() => assertPermanentLeadStatus('pending')); assert.deepEqual(uniqueObjectIds(['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439011']), ['507f1f77bcf86cd799439011']); assert.throws(() => uniqueObjectIds(['bad-id']));
});

test('Lead defaults to pending and only accepts the permanent lifecycle values', () => {
  const lead = new Lead({ businessName: 'Shop', domain: 'shop.test', website: 'https://shop.test/', email: 'hello@shop.test', searchJobId: new mongoose.Types.ObjectId(), category: 'Fashion', location: 'India', isEcommerce: true });
  assert.equal(lead.status, 'pending');
  assert.equal(lead.validateSync(), undefined);
  lead.status = 'new';
  assert.match(lead.validateSync().errors.status.message, /not a valid enum/);
});

test('permanent lifecycle transitions reject every non-pending target and bulk input is bounded', () => {
  for (const status of ['pending', 'new', 'saved ', null]) assert.throws(() => assertPermanentLeadStatus(status));
  const ids = Array.from({ length: 101 }, () => '507f1f77bcf86cd799439011');
  assert.throws(() => uniqueObjectIds([]));
  assert.throws(() => uniqueObjectIds(ids));
});

test('same-job duplicate tracker recognizes normalized domains without using business names', () => {
  const seen = createSeenDomainTracker();
  assert.equal(seen(normalizeDomain('https://www.brand.example/shop')), false);
  assert.equal(seen(normalizeDomain('https://brand.example/contact')), true);
  assert.equal(seen(normalizeDomain('https://another-brand.example')), false);
});

test('workflow API exposes durable current state, scoped mutations, and distinct lock codes', async () => {
  const routes = await readFile(new URL('../src/routes.js', import.meta.url), 'utf8');
  const services = await readFile(new URL('../src/services.js', import.meta.url), 'utf8');
  assert.match(routes, /router\.get\('\/discovery\/current'/);
  assert.match(routes, /const current = await currentDiscovery\(\{ releaseResolved: true \}\);/);
  assert.match(routes, /!\['queued', 'running'\]\.includes\(job\.status\)/);
  assert.match(routes, /jobPayload\(job, pendingCount\)/);
  assert.doesNotMatch(routes, /lastJob\?\.status === 'cancelled'/);
  assert.match(routes, /jobId: null, status: null, pendingCount: 0/);
  assert.match(routes, /current\.job \? jobPayload\(current\.job, current\.pendingCount\)/);
  assert.match(routes, /router\.post\('\/discovery\/recover'/);
  assert.match(routes, /SEARCH_BLOCKED_ACTIVE_JOB/);
  assert.match(routes, /SEARCH_BLOCKED_PENDING_LEADS/);
  assert.match(routes, /Lead\.deleteMany\(\{ status: 'pending', searchJobId: req\.params\.id \}\)/);
  assert.match(routes, /status: 'pending', searchJobId: current\.job\._id/);
  assert.match(routes, /SearchHistory\.updateOne\(\{ searchJobId: job\._id \}/);
  assert.match(services, /const wasSeenThisJob = createSeenDomainTracker/);
  assert.match(services, /status: 'pending', searchJobId: jobId/);
  assert.match(services, /workerLeaseUntil/);
  assert.match(services, /recoverStaleDiscoveries/);
  assert.match(services, /workerToken: token/);
});

test('frontend recovery and permanent-lead UI use the current-state and bulk APIs', async () => {
  const app = await readFile(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const routes = await readFile(new URL('../src/routes.js', import.meta.url), 'utf8');
  assert.match(app, /\/api\/discovery\/current/);
  assert.match(app, /function startPolling\(\) \{ if \(!state\.jobId \|\| !active\(state\.currentJob\?\.status\) \|\| state\.poll\) return; state\.poll = setInterval\(poll, 2500\); void poll\(\); \}/);
  assert.doesNotMatch(app, /Lead restored for review|data-status="pending"/);
  assert.match(routes, /\/leads\/bulk-status/);
  assert.match(routes, /status: 'pending', searchJobId: current\.job\._id/);
  assert.doesNotMatch(routes, /Only saved or Not Useful leads can be restored/);
  assert.match(app, /Cancelling…/);
  assert.match(app, /const version = \+\+state\.jobVersion;\n  \/\/ Clear the interval[\s\S]*?stopPolling\(\);[\s\S]*?await api\(`\/api\/discovery\/jobs\/\$\{jobId\}\/cancel`/);
  assert.match(app, /await fetchJobStatus\(jobId, version\)/);
  assert.match(app, /state\.jobId !== jobId \|\| state\.jobVersion !== version/);
  assert.match(app, /if \(state\.pollInFlight\?\.jobId === jobId && state\.pollInFlight\.version === version\) return;/);
  assert.match(app, /const previousJob = state\.currentJob;[\s\S]*?state\.currentJob = previousJob;[\s\S]*?startPolling\(\);/);
  assert.match(app, /pending-metric-count/);
});


test('discovery recovery and cancellation suppress stale client state', async () => {
  const app = await readFile(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const routes = await readFile(new URL('../src/routes.js', import.meta.url), 'utf8');

  assert.match(routes, /A refresh restores both an active session and a terminal review queue/);
  assert.match(routes, /void recoverStaleDiscoveries\(\)/);
  assert.match(app, /if \(current\.jobId\) \{/);
  assert.match(app, /\$\('#job-progress'\)\.hidden = !active\(current\.status\)/);
  assert.match(app, /state\.pendingCount = Number\(current\.pendingCount\) \|\| 0/);
  assert.match(app, /if \(view === 'pending' && version !== state\.jobVersion\) return/);
  assert.match(app, /const version = \+\+state\.jobVersion;[\s\S]*?stopPolling\(\);[\s\S]*?await api\(`\/api\/discovery\/jobs\/\$\{jobId\}\/cancel`[\s\S]*?await fetchJobStatus\(jobId, version\)/);
  assert.match(app, /Terminal sessions retain their id for review actions, but never their spinner/);
  assert.match(app, /await loadLeads\('pending', \{ cancelled: job\.status === 'cancelled' \}\)/);
  assert.match(app, /Review the remaining leads: Save, mark Not Useful, or Clear them/);
  assert.match(app, /pending: options\.cancelled \? \['Search cancelled', 'No leads remain for review\.'\]/);
});
