import test from 'node:test';
import assert from 'node:assert/strict';
import { corsOptionsForRequest, deleteCampaign, deleteMatchingLeads, isAllowedCorsOrigin, leadDeletionFilter, leadDeletionPreview, managementPipeline } from '../src/app.js';
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

import { applyDateRange, parseDateRange } from '../src/utils.js';

test('date filters use inclusive UTC calendar days and reject inverted ranges', () => {
  const range = parseDateRange({ from: '2026-01-01', to: '2026-01-31' }, 'savedAt');
  assert.equal(range.from.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(range.to.toISOString(), '2026-02-01T00:00:00.000Z');
  assert.deepEqual(applyDateRange({}, range), { savedAt: { $gte: range.from, $lt: range.to } });
  assert.throws(() => parseDateRange({ from: '2026-02-01', to: '2026-01-31' }, 'savedAt'), /greater than or equal/);
});

test('regression contracts: timestamps, filtered CSV and guarded permanent deletion exist server-side', () => {
  const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const models = fs.readFileSync(new URL('../src/models.js', import.meta.url), 'utf8');
  assert.match(models, /savedAt/); assert.match(models, /notUsefulAt/);
  assert.match(app, /\/api\/leads\/export/); assert.match(app, /replace\(\/"\/g, '\"\"'\)/);
  assert.match(app, /\/api\/settings\/lead-deletion\/count/); assert.match(app, /confirmation !== 'DELETE'/);
  assert.match(app, /status: action, savedAt/);
});

const deletionLeads = [
  { id: 'new-in-range', status: 'new', discoveredAt: new Date('2026-01-15'), savedAt: null, notUsefulAt: null },
  { id: 'new-out-of-range', status: 'new', discoveredAt: new Date('2026-02-15'), savedAt: null, notUsefulAt: null },
  { id: 'saved-in-range', status: 'saved', discoveredAt: new Date('2025-12-01'), savedAt: new Date('2026-01-15'), notUsefulAt: null },
  { id: 'saved-discovered-in-range', status: 'saved', discoveredAt: new Date('2026-01-15'), savedAt: new Date('2025-12-01'), notUsefulAt: null },
  { id: 'discarded-in-range', status: 'discarded', discoveredAt: new Date('2025-12-01'), savedAt: null, notUsefulAt: new Date('2026-01-15') },
  { id: 'discarded-discovered-in-range', status: 'discarded', discoveredAt: new Date('2026-01-15'), savedAt: null, notUsefulAt: new Date('2025-12-01') }
];
const matchesFilter = (lead, filter) => Object.entries(filter).every(([key, condition]) => {
  if (key === 'status') return lead.status === condition;
  return (!condition.$gte || lead[key] >= condition.$gte) && (!condition.$lt || lead[key] < condition.$lt);
});
const fakeLeadModel = (leads) => ({
  countDocuments: async filter => leads.filter(lead => matchesFilter(lead, filter)).length,
  deleteMany: async filter => {
    const matching = leads.filter(lead => matchesFilter(lead, filter));
    matching.forEach(lead => leads.splice(leads.indexOf(lead), 1));
    return { deletedCount: matching.length };
  }
});

test('settings deletion dates use each lead lifecycle timestamp', () => {
  const custom = { scope: 'custom', from: '2026-01-01', to: '2026-01-31' };
  assert.equal(leadDeletionFilter({ ...custom, status: 'saved' }).savedAt.$gte.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(leadDeletionFilter({ ...custom, status: 'discarded' }).notUsefulAt.$gte.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(leadDeletionFilter({ ...custom, status: 'new' }).discoveredAt.$gte.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(leadDeletionFilter({ ...custom, status: 'all' }).discoveredAt.$gte.toISOString(), '2026-01-01T00:00:00.000Z');
});

test('settings deletion preview is the actual matching set and deletes only intended leads', async () => {
  const leads = structuredClone(deletionLeads); const model = fakeLeadModel(leads);
  const payload = { status: 'saved', scope: 'custom', from: '2026-01-01', to: '2026-01-31' };
  const preview = await leadDeletionPreview(model, payload);
  assert.equal(preview.count, 1);
  assert.equal(preview.breakdown.total, 1);
  assert.equal(await deleteMatchingLeads(model, { ...payload, confirmation: 'DELETE' }), preview.count);
  assert.deepEqual(leads.map(lead => lead.id).sort(), deletionLeads.filter(lead => lead.id !== 'saved-in-range').map(lead => lead.id).sort());
});

test('settings deletion matches Saved, Not Useful, and New records by their selected date', async () => {
  for (const [status, expectedId] of [['saved', 'saved-in-range'], ['discarded', 'discarded-in-range'], ['new', 'new-in-range']]) {
    const preview = await leadDeletionPreview(fakeLeadModel(structuredClone(deletionLeads)), { status, scope: 'custom', from: '2026-01-01', to: '2026-01-31' });
    assert.equal(preview.count, 1, `${status} should match only ${expectedId}`);
  }
});

test('settings deletion rejects invalid ranges and confirmation', async () => {
  assert.throws(() => leadDeletionFilter({ status: 'new', scope: 'custom', from: '2026-02-01', to: '2026-01-31' }), /greater than or equal/);
  await assert.rejects(deleteMatchingLeads(fakeLeadModel(structuredClone(deletionLeads)), { status: 'new', confirmation: 'delete' }), /Type DELETE/);
});

test('checkpoint recovery writes a lead before moving its durable cursor and guards lease ownership', () => {
  const services = fs.readFileSync(new URL('../src/services.js', import.meta.url), 'utf8');
  const create = services.indexOf('created = await Lead.create');
  const advance = services.indexOf("$inc: { foundCount: 1, 'checkpoint.candidateIndex': 1 }");
  assert.ok(create >= 0 && advance > create, 'lead creation must precede cursor advancement');
  assert.match(services, /renewWorkerLease/);
  assert.match(services, /workerLeaseExpiresAt: \{ \$gt: new Date\(\) \}/);
  assert.match(services, /await Lead\.deleteOne\(\{ _id: created\._id, status: 'new' \}\)/);
});

test('client invalidates stale polling callbacks when cancellation completes', () => {
  const client = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(client, /pollGeneration/);
  assert.match(client, /generation !== state\.pollGeneration/);
  assert.match(client, /stopPolling\(\); setDiscoveryRunning\(true, true\)/);
  assert.match(client, /\$\('#job-progress'\)\.hidden = true/);
});

import { emailConfiguration, normalizeBatchResponse, sendEmailBatch } from '../src/services/email.js';

test('email readiness validates missing configuration and sender format without exposing credentials', () => {
  assert.deepEqual(emailConfiguration({ resendApiKey: '', emailFrom: '' }).missing.sort(), ['EMAIL_FROM', 'RESEND_API_KEY']);
  assert.equal(emailConfiguration({ resendApiKey: 'secret', emailFrom: 'not-an-address' }).code, 'EMAIL_INVALID_SENDER');
  assert.equal(emailConfiguration({ resendApiKey: 'secret', emailFrom: 'sender@verified.example' }).ready, true);
  assert.equal(emailConfiguration({ resendApiKey: 'secret', emailFrom: 'LeadScout <sender@verified.example>' }).ready, true);
});
test('Resend batch responses retain item-level outcomes and message ids', () => {
  assert.deepEqual(normalizeBatchResponse({ data: { data: [{ id: 'message-1' }, { error: { message: 'recipient rejected' } }] } }, 2), [{ ok: true, id: 'message-1' }, { ok: false, code: 'EMAIL_PROVIDER_REJECTED', reason: 'The email provider rejected this request.' }]);
  assert.throws(() => normalizeBatchResponse({ error: { message: 'sender domain rejected' } }, 1), error => error.code === 'EMAIL_INVALID_SENDER');
  const partial = normalizeBatchResponse({ data: { data: [{ error: { message: 'API key abc should not be shown' } }] } }, 1)[0];
  assert.equal(partial.reason, 'The email provider rejected this request.');
});
test('email sending preserves batch idempotency and maps successful provider ids', async () => {
  const calls = []; class FakeResend { constructor(key) { assert.equal(key, 'key'); } batch = { send: async (_messages, options) => { calls.push(options); return { data: { data: [{ id: 'provider-id' }] } }; } }; }
  const result = await sendEmailBatch([{ to: 'to@example.org', subject: 'Hi', text: 'Hello' }], 'campaign:1:batch:retry-safe', { resendApiKey: 'key', emailFrom: 'from@verified.example' }, FakeResend);
  assert.deepEqual(result, [{ ok: true, id: 'provider-id' }]); assert.equal(calls[0].idempotencyKey, 'campaign:1:batch:retry-safe');
});
test('outreach regression contracts include recipient failures, activity history, and structured send summaries', () => {
  const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(app, /recordEmailFailure/); assert.match(app, /OutreachActivity\.create/); assert.match(app, /failures/); assert.match(app, /EMAIL_RECIPIENT_INVALID/);
  assert.match(app, /pending: counts\.emailPending/);
});
test('workspace DOM contracts cover compact cards, filter surface, and campaign metrics', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'); const client = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="saved-filter-panel"/); assert.match(html, /role="tab"/); assert.match(client, /lead-card-list/); assert.match(client, /try \{ const result = await api/); assert.match(client, /<details>/); assert.match(client, /campaign-metrics/); assert.match(client, /Batch failed/);
});

test('campaign deletion removes only campaign recipients and preserves activity history', async () => {
  const campaign = { _id: '507f1f77bcf86cd799439011', status: 'completed' };
  const deletedRecipients = []; const activities = [{ campaignId: campaign._id, status: 'sent' }];
  const campaignModel = {
    findById: () => ({ lean: async () => campaign }),
    findOneAndDelete: filter => filter.status.$ne === 'sending' ? { lean: async () => campaign } : { lean: async () => null }
  };
  const recipientModel = { deleteMany: async filter => { deletedRecipients.push(filter); return { deletedCount: 1 }; } };
  const result = await deleteCampaign(campaignModel, recipientModel, campaign._id);
  assert.equal(result._id, campaign._id);
  assert.deepEqual(deletedRecipients, [{ campaignId: campaign._id }]);
  assert.equal(activities.length, 1, 'outreach history is never passed to campaign deletion');
});

test('sending campaigns cannot be deleted', async () => {
  const campaign = { _id: '507f1f77bcf86cd799439011', status: 'sending' };
  const campaignModel = { findById: () => ({ lean: async () => campaign }) };
  await assert.rejects(deleteCampaign(campaignModel, { deleteMany: async () => assert.fail('must not delete recipients') }, campaign._id), error => error.status === 409 && error.code === 'CAMPAIGN_SENDING');
});

test('management history pipeline derives latest independent channel statuses from OutreachActivity', () => {
  const pipeline = managementPipeline({ status: 'saved', tab: 'contacted', communicationStatus: 'failed' });
  const source = JSON.stringify(pipeline);
  assert.match(source, /outreachactivities/);
  assert.match(source, /activityAt/);
  assert.match(source, /emailStatus/); assert.match(source, /whatsappStatus/);
  assert.match(source, /manual_sent/); assert.match(source, /failed/);
  assert.match(source, /lastContacted/);
});

test('campaign deletion and mobile status UI contracts preserve historical states', () => {
  const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const client = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/css/styles.css', import.meta.url), 'utf8');
  assert.match(app, /app\.delete\('\/api\/campaigns\/:id'/);
  assert.match(app, /recipientModel\.deleteMany/); assert.doesNotMatch(app.match(/export async function deleteCampaign[\s\S]*?return deleted;/)?.[0] || '', /OutreachActivity\.delete/);
  assert.match(app, /Deleted campaign/);
  assert.match(client, /data-delete-campaign/); assert.match(client, /Delete this campaign\?/); assert.match(client, /Existing email and WhatsApp outreach history/);
  assert.match(client, /status-sent/); assert.match(client, /status-not-sent/); assert.match(client, /status-failed/);
  assert.match(css, /\.lead-tabs \{ display:flex; flex-wrap:nowrap/); assert.match(css, /flex:0 0 auto/); assert.match(css, /\.lead-statuses \{ display:flex; flex-wrap:wrap; gap:6px/);
});
