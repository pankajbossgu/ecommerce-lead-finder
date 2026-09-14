import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import mongoose from 'mongoose';
import { Lead } from '../src/models.js';
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

test('frontend recovery and permanent-lead UI use the current-state and bulk APIs', async () => {
  const app = await readFile(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const routes = await readFile(new URL('../src/routes.js', import.meta.url), 'utf8');
  assert.match(app, /\/api\/discovery\/current/);
  assert.match(app, /if \(state\.jobId && !state\.poll\) state\.poll = setInterval/);
  assert.doesNotMatch(app, /Lead restored for review|data-status="pending"/);
  assert.match(routes, /\/leads\/bulk-status/);
  assert.match(routes, /status: 'pending', searchJobId: current\.job\._id/);
  assert.doesNotMatch(routes, /Only saved or Not Useful leads can be restored/);
});
