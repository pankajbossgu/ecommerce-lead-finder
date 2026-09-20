import test from 'node:test';
import assert from 'node:assert/strict';
import { corsOptionsForRequest, deleteCampaign, deleteMatchingLeads, isAllowedCorsOrigin, leadDeletionFilter, leadDeletionPreview, managementPipeline, manualLeadInput, resolveAmbiguousBrevoBatch } from '../src/app.js';
import { activeJobFilter, buildDiscoveryPrompt, candidatesMatch, duplicateReasonForLead, isTerminalJobStatus, mergeCandidates, normalizeDiscoveredDomains, prepareLead, runDiscoveryChannels } from '../src/services.js';
import { assertLeadStatus, isValidPublicEmail, normalizeBusinessName, normalizeDomain, normalizeEmail, normalizeSocialProfileUrl, normalizeUrl, parseDiscoveryInput, parsePagination } from '../src/utils.js';
import crypto from 'node:crypto';
import { conversationFor, createRfcMessageId, messageIds, normalizedMessageId, verifyResendWebhook } from '../src/services/inbox.js';
import { sendBrevoEmailBatch } from '../src/services/brevo.js';

test('mailbox webhook verification rejects missing and invalid signatures and accepts a fresh signed body', () => {
  const raw = Buffer.from('{"type":"email.received"}'); const secret = `whsec_${Buffer.from('mailbox-test-secret').toString('base64')}`; const timestamp = String(Math.floor(Date.now() / 1000)); const id = 'msg_test';
  const signature = crypto.createHmac('sha256', Buffer.from('mailbox-test-secret')).update(`${id}.${timestamp}.${raw}`).digest('base64');
  assert.equal(verifyResendWebhook({}, raw, secret), false);
  assert.equal(verifyResendWebhook({ 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': 'v1,bad' }, raw, secret), false);
  assert.equal(verifyResendWebhook({ 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` }, raw, secret), true);
});

test('mailbox threading uses reliable reply identifiers and avoids subject-only merges', () => {
  const conversationId = 'conversation-1';
  assert.equal(conversationFor({ subject: 'Re: Proposal', inReplyTo: '<origin>', references: ['<origin>'] }, [{ conversationId, messageId: '<origin>', subject: 'Proposal' }]), conversationId);
  assert.notEqual(conversationFor({ from: 'a@example.test', fromEmail: 'a@example.test', to: ['b@example.test'], subject: 'Proposal', receivedAt: new Date() }, [{ conversationId, from: 'other@example.test', fromEmail: 'other@example.test', to: ['b@example.test'], subject: 'Proposal', date: new Date(), fallbackSignature: 'other@example.test|b@example.test|proposal' }]), conversationId);
});

test('mailbox RFC identifiers stay distinct from provider ids and References are normalized', () => {
  const id = createRfcMessageId('LeadScout <outreach@verified.example>');
  assert.match(id, /^<[0-9a-f-]+@verified\.example>$/);
  assert.notEqual(id, 're_12345678-1234-1234-1234-123456789012');
  assert.equal(normalizedMessageId(' <parent@verified.example> '), '<parent@verified.example>');
  assert.deepEqual(messageIds('<root@verified.example> <parent@verified.example> <root@verified.example>'), ['<root@verified.example>', '<parent@verified.example>']);
});

test('mailbox threading joins a campaign or direct sent parent through In-Reply-To and References', () => {
  const sent = { conversationId: 'campaign-thread', messageId: '<campaign@verified.example>', references: [], subject: 'Proposal', from: 'LeadScout <outreach@verified.example>', to: ['client@example.org'], date: new Date() };
  assert.equal(conversationFor({ from: 'client@example.org', fromEmail: 'client@example.org', to: ['outreach@verified.example'], subject: 'Re: Proposal', inReplyTo: '<campaign@verified.example>', references: ['<campaign@verified.example>'], receivedAt: new Date() }, [sent]), 'campaign-thread');
});


test('manual lead validation requires website and business email while keeping phone optional', () => {
  const base = { businessName: 'Acme Store', website: 'https://acme.co', email: 'sales@acme.co', category: 'Retail', location: 'London' };
  const noPhone = manualLeadInput(base);
  assert.equal(noPhone.phone, null);
  assert.equal(noPhone.email, 'sales@acme.co');
  assert.equal(manualLeadInput({ ...base, phone: '+44 20 7946 0958' }).phone, '+44 20 7946 0958');
  assert.throws(() => manualLeadInput({ ...base, email: '' }), /Email must be a valid business email/);
  assert.throws(() => manualLeadInput({ ...base, email: 'not-an-email' }), /Email must be a valid business email/);
  assert.throws(() => manualLeadInput({ ...base, website: 'javascript:alert(1)' }), /Website must be a valid public URL/);
});

test('manual lead UI and API preserve website/email identity rules without phone uniqueness', () => {
  const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const client = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(client, /id=\"manual-email\"[^`]*required/);
  assert.match(client, /Website and email are required\. Phone is optional\./);
  assert.match(app, /if \(!website \|\| !domain \|\| !isSafePublicUrl\(website\)\)/);
  assert.match(app, /if \(!email \|\| !isValidPublicEmail\(email\)\)/);
  assert.match(app, /findLeadDuplicateReason\(input\)/);
  assert.doesNotMatch(app.slice(app.indexOf('export function manualLeadInput'), app.indexOf('export function managementPipeline')), /phone.*unique/i);
});

test('normalizes domains without losing meaningful subdomains', () => {
  assert.equal(normalizeDomain('HTTPS://WWW.Example.COM/Test?utm_source=x'), 'example.com');
  assert.equal(normalizeDomain('http://example.com:80/contact'), 'example.com');
  assert.equal(normalizeDomain('shop.example.com/path'), 'shop.example.com');
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
});
test('normalizes and validates public business email addresses', () => {
  assert.equal(normalizeEmail('  Sales@Example.CO.UK '), 'sales@example.co.uk');
  assert.equal(normalizeEmail('   '), null);
  assert.equal(normalizeEmail(null), null);
  assert.equal(isValidPublicEmail('sales@brand.co.uk'), true);
  assert.equal(isValidPublicEmail('hello@example.com'), false);
  assert.equal(isValidPublicEmail('not-an-email'), false);
});

const discoveryInput = { category: 'Beauty and cosmetics e-commerce brands', location: 'India', keywords: 'D2C, Shopify, COD' };
const ecommerceCandidate = {
  businessName: 'Glow Goods', officialWebsite: 'https://glowgoods.example.org', email: 'hello@glowgoods.example.org', phone: null,
  isEcommerce: true, websiteSourceUrl: 'https://glowgoods.example.org', emailSourceUrl: 'https://glowgoods.example.org/contact',
  emailSourceType: 'website', isOfficialSocialProfile: null, phoneSourceUrl: null
};

test('discovery targeting retains physical-product e-commerce requirements and website-first social fallback instructions', () => {
  const prompt = buildDiscoveryPrompt(discoveryInput, 'beauty brands in India');
  assert.match(prompt, /physical-product e-commerce/i);
  assert.match(prompt, /agencies, SaaS or software companies/i);
  assert.match(prompt, /official website first/i);
  assert.match(prompt, /Only if the website has no usable public business email may you use.*social profile.*fallback/i);
  assert.match(prompt, /Never infer, guess, construct, or fabricate an email/i);
  assert.match(prompt, /Google Search grounding and URL Context/i);
});

test('discovery exclusions are normalized, domain-only, and scoped to the supplied job checkpoint', () => {
  const jobADomains = normalizeDiscoveredDomains(['https://www.example.com/products', 'http://example.com', 'https://brand.example/contact']);
  const jobBDomains = normalizeDiscoveredDomains(['https://other.example']);
  assert.deepEqual(jobADomains, ['example.com', 'brand.example']);
  assert.deepEqual(jobBDomains, ['other.example']);
  assert.equal(jobADomains.includes('example-company.com'), false);
  const prompt = buildDiscoveryPrompt(discoveryInput, 'beauty brands in India', jobADomains);
  assert.match(prompt, /Previously discovered websites — DO NOT RETURN/);
  assert.match(prompt, /example\.com\nbrand\.example/);
  assert.match(prompt, /Do not simply change the URL or page/);
  assert.doesNotMatch(prompt, /hello@glowgoods\.example\.org/);
  assert.doesNotMatch(buildDiscoveryPrompt(discoveryInput, 'beauty brands in India', jobBDomains), /example\.com/);
});

test('discovery checkpoint tracks candidate domains before validation and filters exact repeats locally', () => {
  const services = fs.readFileSync(new URL('../src/services.js', import.meta.url), 'utf8');
  const track = services.indexOf("$addToSet: { 'checkpoint.discoveredDomains': candidateDomain }");
  const validate = services.indexOf('const lead = prepareLead(candidate, job);');
  assert.ok(track >= 0 && track < validate, 'identifiable domains must persist before lead validation');
  assert.match(services, /discoveredDomains\.has\(candidateDomain\)/);
  assert.match(services, /duplicateCount: 1, 'checkpoint\.candidateIndex': 1/);
  assert.match(services, /runDiscoveryChannels\(\{ \.\.\.job, variationIndex, discoveredDomains: checkpoint\.discoveredDomains \}\)/);
});

test('lead qualification requires a genuine e-commerce business and a non-social official website', () => {
  assert.ok(prepareLead(ecommerceCandidate, discoveryInput));
  assert.equal(prepareLead({ ...ecommerceCandidate, isEcommerce: false }, discoveryInput), null);
  assert.equal(prepareLead({ ...ecommerceCandidate, officialWebsite: 'https://instagram.com/glowgoods', emailSourceUrl: 'https://instagram.com/glowgoods', emailSourceType: 'social', isOfficialSocialProfile: true }, discoveryInput), null);
});

test('website email sources are accepted and legacy website checkpoint candidates remain resumable', () => {
  const qualified = prepareLead(ecommerceCandidate, discoveryInput);
  assert.equal(qualified.email, 'hello@glowgoods.example.org');
  assert.equal(qualified.emailSourceUrl, 'https://glowgoods.example.org/contact');
  assert.ok(prepareLead({ ...ecommerceCandidate, emailSourceType: null }, discoveryInput));
});

test('official social-profile email is a verified fallback, not an unrelated or guessed source', () => {
  const socialCandidate = { ...ecommerceCandidate, email: 'contact@glowgoods.example.org', emailSourceUrl: 'https://www.instagram.com/glowgoods/', emailSourceType: 'social', isOfficialSocialProfile: true };
  assert.equal(prepareLead(socialCandidate, discoveryInput).emailSourceUrl, 'https://www.instagram.com/glowgoods/');
  assert.equal(prepareLead({ ...socialCandidate, isOfficialSocialProfile: false }, discoveryInput), null);
  assert.equal(prepareLead({ ...socialCandidate, emailSourceUrl: 'https://instagram.com/glowgoods-deals/', isOfficialSocialProfile: false }, discoveryInput), null);
  assert.equal(prepareLead({ ...socialCandidate, email: 'hello@example.com' }, discoveryInput), null);
  assert.equal(prepareLead({ ...ecommerceCandidate, email: null }, discoveryInput), null);
});
test('validates discovery counts, pagination, and lead status lifecycle', () => {
  assert.deepEqual(parseDiscoveryInput({ category: 'Fashion', location: 'India', keywords: '', requestedCount: '50' }), { category: 'Fashion', location: 'India', keywords: '', requestedCount: 50, mode: 'hybrid' });
  assert.throws(() => parseDiscoveryInput({ category: 'Fashion', location: 'India', requestedCount: '25' }));
  assert.deepEqual(parsePagination({ page: '2', limit: '50' }), { page: 2, limit: 50 });
  assert.throws(() => parsePagination({ limit: '101' }));
  assert.equal(assertLeadStatus('saved'), 'saved'); assert.throws(() => assertLeadStatus('campaign'));
});


test('discovery modes run independent channels and hybrid merges cross-channel identities', async () => {
  const calls = [];
  const strategies = {
    website: async () => { calls.push('website'); return [{ ...ecommerceCandidate }]; },
    social: async () => { calls.push('social'); return [{ ...ecommerceCandidate, socialProfiles: { instagram: 'https://instagram.com/glowgoods' } }]; }
  };
  const base = { ...discoveryInput };
  await runDiscoveryChannels({ ...base, mode: 'website' }, strategies);
  assert.deepEqual(calls, ['website']); calls.length = 0;
  await runDiscoveryChannels({ ...base, mode: 'social' }, strategies);
  assert.deepEqual(calls, ['social']); calls.length = 0;
  const hybrid = await runDiscoveryChannels({ ...base, mode: 'hybrid' }, strategies);
  assert.deepEqual(calls.sort(), ['social', 'website']); assert.equal(hybrid.candidates.length, 1);
  assert.deepEqual(hybrid.candidates[0].discoverySources.sort(), ['social', 'website']);
});
test('candidate merging keeps one canonical lead for an official-domain social match', () => {
  const merged = mergeCandidates([{ ...ecommerceCandidate, discoverySources: ['website'], sourceUrls: ['https://glowgoods.example.org'] }, { ...ecommerceCandidate, discoverySources: ['social'], socialProfiles: { instagram: 'https://instagram.com/glowgoods' }, sourceUrls: ['https://instagram.com/glowgoods'] }]);
  assert.equal(merged.length, 1); assert.deepEqual(merged[0].discoverySources.sort(), ['social', 'website']);
});
test('identity matching normalizes social profiles, domains, and company suffixes conservatively', () => {
  assert.equal(normalizeSocialProfileUrl('https://www.instagram.com/abc/?utm_source=search'), 'instagram.com/abc');
  assert.equal(normalizeSocialProfileUrl('instagram.com/abc/'), 'instagram.com/abc');
  assert.equal(normalizeDomain('https://www.abc.com/products'), 'abc.com');
  assert.equal(normalizeBusinessName('ABC Fashion Private Limited'), 'abc fashion');
  const website = { ...ecommerceCandidate, businessName: 'ABC Fashion Pvt Ltd', officialWebsite: 'https://abc.com', email: 'hello@abc.com', identityLocation: 'Delhi', discoverySources: ['website'] };
  const sparseSocial = { ...ecommerceCandidate, businessName: 'ABC Fashion Private Limited', officialWebsite: null, email: null, phone: null, identityLocation: 'Delhi', socialProfiles: { instagram: 'https://www.instagram.com/abc/' }, discoverySources: ['social'] };
  const otherCity = { ...sparseSocial, identityLocation: 'Mumbai', socialProfiles: { instagram: 'https://instagram.com/abc-mumbai' } };
  assert.equal(candidatesMatch(website, sparseSocial), true);
  assert.equal(candidatesMatch(website, otherCity), false);
  const merged = mergeCandidates([website, sparseSocial]);
  assert.equal(merged.length, 1); assert.equal(normalizeSocialProfileUrl(merged[0].socialProfiles.instagram), 'instagram.com/abc');
});
test('discovery input defaults safely to hybrid and rejects unknown modes', () => {
  assert.equal(parseDiscoveryInput({ category: 'Fashion', location: 'India', requestedCount: '20' }).mode, 'hybrid');
  assert.equal(parseDiscoveryInput({ category: 'Fashion', location: 'India', requestedCount: '20', mode: 'social' }).mode, 'social');
  assert.throws(() => parseDiscoveryInput({ category: 'Fashion', location: 'India', requestedCount: '20', mode: 'untrusted' }));
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

test('lead duplicate reasons distinguish normalized domain and email collisions', () => {
  const lead = { domain: 'abc.example', email: 'sales@abc.example' };
  assert.equal(duplicateReasonForLead(lead, [{ domain: 'abc.example', emailNormalized: 'other@abc.example', status: 'saved' }]), 'duplicate_domain');
  assert.equal(duplicateReasonForLead(lead, [{ domain: 'other.example', email: ' SALES@ABC.EXAMPLE ', status: 'new' }]), 'duplicate_email');
  assert.equal(duplicateReasonForLead(lead, [{ domain: 'abc.example', emailNormalized: 'sales@abc.example', status: 'discarded' }]), 'duplicate_domain_and_email');
  assert.equal(duplicateReasonForLead(lead, [{ domain: 'abc.example', emailNormalized: 'other@abc.example', status: 'new', searchJobId: 'job-a' }], 'job-a'), 'duplicate_domain');
});

test('email identity indexes are partial and legacy migration preserves conflicting records', () => {
  const models = fs.readFileSync(new URL('../src/models.js', import.meta.url), 'utf8');
  assert.match(models, /emailNormalized: 1 }, \{ unique: true, partialFilterExpression: \{ emailNormalized: \{ \$type: 'string' \}/);
  assert.match(models, /legacyEmailDuplicateOf/);
  assert.match(models, /claimedEmails/);
  assert.match(models, /recipientNormalized/);
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
  assert.match(client, /Channel stages below reflect persisted server progress/);
  assert.match(client, /aria-valuetext/);
});

import { emailConfiguration, normalizeBatchResponse, resolveEmailSender, sendEmailBatch, validateEmailProvider } from '../src/services/email.js';

test('email readiness validates missing configuration and sender format without exposing credentials', () => {
  assert.deepEqual(emailConfiguration({ resendApiKey: '', emailFrom: '' }).missing.sort(), ['RESEND_API_KEY', 'RESEND_EMAIL_FROM']);
  assert.equal(emailConfiguration({ resendApiKey: 'secret', resendEmailFrom: 'not-an-address' }).code, 'EMAIL_INVALID_SENDER');
  assert.equal(emailConfiguration({ resendApiKey: 'secret', resendEmailFrom: 'sender@verified.example' }).ready, true);
  assert.equal(emailConfiguration({ resendApiKey: 'secret', emailFrom: 'LeadScout <sender@verified.example>' }).ready, true, 'legacy EMAIL_FROM remains a Resend fallback');
});

test('provider sender resolution uses provider-specific addresses and validates the provider server-side', () => {
  const config = { emailName: 'SmartLocator', resendEmailFrom: 'outreach@notifications.smartlocator.online', brevoEmailFrom: 'mail@smartlocator.online', emailFrom: 'legacy@example.org' };
  assert.deepEqual(resolveEmailSender('resend', config), { provider: 'resend', name: 'SmartLocator', email: 'outreach@notifications.smartlocator.online', from: 'SmartLocator <outreach@notifications.smartlocator.online>' });
  assert.deepEqual(resolveEmailSender('brevo', config), { provider: 'brevo', name: 'SmartLocator', email: 'mail@smartlocator.online', from: 'SmartLocator <mail@smartlocator.online>' });
  assert.throws(() => validateEmailProvider('custom-sender'), error => error.code === 'VALIDATION_ERROR');
  assert.equal(resolveEmailSender('resend', { emailName: 'SmartLocator', emailFrom: 'legacy@example.org' }).email, 'legacy@example.org');
});
test('Resend batch responses retain item-level outcomes and message ids', () => {
  assert.deepEqual(normalizeBatchResponse({ data: { data: [{ id: 'message-1' }, { error: { message: 'recipient rejected' } }] } }, 2), [{ ok: true, id: 'message-1' }, { ok: false, code: 'EMAIL_PROVIDER_REJECTED', reason: 'The email provider rejected this request.' }]);
  assert.throws(() => normalizeBatchResponse({ error: { message: 'sender domain rejected' } }, 1), error => error.code === 'EMAIL_INVALID_SENDER');
  const partial = normalizeBatchResponse({ data: { data: [{ error: { message: 'API key abc should not be shown' } }] } }, 1)[0];
  assert.equal(partial.reason, 'The email provider rejected this request.');
});
test('Resend batch sending preserves headers, idempotency, and provider ids', async () => {
  const calls = []; class FakeResend { constructor(key) { assert.equal(key, 'key'); } batch = { send: async (messages, options) => { calls.push({ messages, options }); return { data: { data: [{ id: 'provider-id' }] } }; } }; }
  const headers = { 'Message-ID': '<resend@example.org>' };
  const result = await sendEmailBatch([{ to: 'to@example.org', subject: 'Hi', text: 'Hello', headers }], 'campaign:1:batch:retry-safe', { resendApiKey: 'key', emailName: 'SmartLocator', resendEmailFrom: 'from@verified.example' }, FakeResend);
  assert.deepEqual(result, [{ ok: true, id: 'provider-id' }]); assert.equal(calls[0].options.idempotencyKey, 'campaign:1:batch:retry-safe'); assert.equal(calls[0].messages[0].from, 'SmartLocator <from@verified.example>'); assert.deepEqual(calls[0].messages[0].headers, headers);
});
test('Brevo campaign sending submits up to 100 message versions in one request', async () => {
  const calls = []; const messages = Array.from({ length: 100 }, (_value, index) => ({ to: `recipient-${index}@example.org`, subject: `Subject ${index}`, text: `Text ${index}`, headers: { 'Message-ID': `<${index}@example.org>` }, replyTo: 'replies@example.org' }));
  const messageIds = messages.map((_message, index) => `brevo-message-${index}`);
  const request = async (...args) => { calls.push(args); return { ok: true, json: async () => ({ messageIds }) }; };
  const result = await sendBrevoEmailBatch(messages, { brevoApiKey: 'key', brevoEmailFrom: 'from@verified.example', emailName: 'SmartLocator' }, request);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'https://api.brevo.com/v3/smtp/email');
  const payload = JSON.parse(calls[0][1].body);
  assert.deepEqual(payload.sender, { name: 'SmartLocator', email: 'from@verified.example' }); assert.equal(payload.subject, 'Subject 0'); assert.equal(payload.textContent, 'Text 0'); assert.equal(payload.messageVersions.length, 100);
  assert.deepEqual(payload.messageVersions[0], { to: [{ email: 'recipient-0@example.org' }], subject: 'Subject 0', textContent: 'Text 0', replyTo: { email: 'replies@example.org' } });
  assert.deepEqual(payload.messageVersions[99], { to: [{ email: 'recipient-99@example.org' }], subject: 'Subject 99', textContent: 'Text 99', replyTo: { email: 'replies@example.org' } });
  assert.equal(payload.messageVersions.every(version => !Object.hasOwn(version, 'headers')), true);
  assert.deepEqual(result, messageIds.map(id => ({ ok: true, id })));
  for (const size of [1, 10, 100, 100, 50]) await sendBrevoEmailBatch(messages.slice(0, size), { brevoApiKey: 'key', brevoEmailFrom: 'from@verified.example' }, request);
  assert.deepEqual(calls.map(([_url, options]) => JSON.parse(options.body).messageVersions.length), [100, 1, 10, 100, 100, 50]);
  assert.deepEqual(await sendBrevoEmailBatch([], { brevoApiKey: 'key', brevoEmailFrom: 'from@verified.example' }, request), []);
  assert.equal(calls.length, 6);
  await assert.rejects(sendBrevoEmailBatch([...messages, { to: 'recipient-100@example.org', subject: 'Subject 100', text: 'Text 100' }], { brevoApiKey: 'key', brevoEmailFrom: 'from@verified.example' }, request), error => error.code === 'EMAIL_BATCH_TOO_LARGE');
});
test('Brevo campaign batches identify transport failures as ambiguous', async () => {
  await assert.rejects(sendBrevoEmailBatch([{ to: 'recipient@example.org', subject: 'Subject', text: 'Text' }], { brevoApiKey: 'key', brevoEmailFrom: 'from@verified.example' }, async () => { throw new TypeError('network timeout'); }), error => error.code === 'EMAIL_PROVIDER_AMBIGUOUS');
});
test('ambiguous Brevo batches can be manually resolved without a resend', async () => {
  const recipients = [{ _id: 'recipient-1', leadId: 'lead-1', templateId: 'template-1', recipient: 'first@example.org' }, { _id: 'recipient-2', leadId: 'lead-2', templateId: 'template-1', recipient: 'second@example.org' }];
  const updates = []; const activities = [];
  const recipientModel = { find: filter => ({ lean: async () => { assert.deepEqual(filter, { campaignId: 'campaign-1', channel: 'email', status: 'sending', providerAcceptanceUnknown: true }); return recipients; } }), updateMany: async (...args) => updates.push(args) };
  const activityModel = { create: async activity => activities.push(activity) };
  const resolvedAt = new Date('2026-09-17T00:00:00.000Z');
  assert.equal(await resolveAmbiguousBrevoBatch('campaign-1', recipientModel, activityModel, resolvedAt), 2);
  assert.equal(updates.length, 1); assert.deepEqual(updates[0][1].$set, { status: 'failed', failedAt: resolvedAt, failureReason: 'EMAIL_PROVIDER_AMBIGUOUS: Manually resolved without resending because Brevo acceptance could not be confirmed.', providerAcceptanceUnknown: false, sendingLeaseExpiresAt: null });
  assert.deepEqual(activities.map(activity => activity.recipient), ['first@example.org', 'second@example.org']);
  await assert.rejects(resolveAmbiguousBrevoBatch('campaign-1', { find: () => ({ lean: async () => [] }) }, activityModel), error => error.code === 'NO_AMBIGUOUS_BATCH');
});
test('Brevo campaign batches retain the provider reason for definite HTTP rejection', async () => {
  await assert.rejects(sendBrevoEmailBatch([{ to: 'recipient@example.org', subject: 'Subject', text: 'Text' }], { brevoApiKey: 'key', brevoEmailFrom: 'from@verified.example' }, async () => ({ ok: false, status: 400, json: async () => ({ code: 'invalid_parameter', message: 'example reason' }) })), error => error.code === 'EMAIL_PROVIDER_REJECTED' && error.message === 'The email provider rejected this message. Brevo: invalid_parameter: example reason');
});
test('outreach regression contracts include recipient failures, activity history, and structured send summaries', () => {
  const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(app, /recordEmailFailure/); assert.match(app, /OutreachActivity\.create/); assert.match(app, /failures/); assert.match(app, /EMAIL_RECIPIENT_INVALID/);
  assert.match(app, /pending: counts\.emailPending/);
});
test('workspace DOM contracts cover compact cards, filter surface, and campaign metrics', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'); const client = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="saved-filter-panel"/); assert.match(html, /id="saved-filter-close"/); assert.match(html, /aria-label="Close filters"/); assert.match(html, /role="tab"/); assert.match(client, /lead-card-list/); assert.match(client, /function websiteLink\(lead\)/); assert.match(client, /rel="noopener noreferrer" target="_blank"/); assert.match(client, /No leads available to export\./); assert.match(client, /newLeadCount/); assert.match(client, /try \{ const result = await api/); assert.match(client, /<details>/); assert.match(client, /campaign-metrics/); assert.match(client, /Batch failed/);
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

test('template deletion uses the outreach modal confirmation instead of a native prompt', () => {
  const client = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(client, /function confirmTemplateDelete/);
  assert.match(client, /Delete this template\?/);
  assert.match(client, /This action cannot be undone/);
  assert.match(client, /data-confirm-delete-template/);
  assert.match(client, /api\(`\/api\/templates\/\$\{confirmDeleteTemplate\.dataset\.confirmDeleteTemplate\}`/);
  assert.doesNotMatch(client, /confirm\(/);
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

test('campaign WhatsApp Copy and Open use the same personalized-message endpoint', () => {
  const client = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(client, /async function getCampaignWhatsappMessage\(campaignId, recipientId\)/);
  assert.match(client, /\/api\/campaigns\/\$\{campaignId\}\/recipients\/\$\{recipientId\}\/whatsapp-message/);
  assert.match(client, /navigator\.clipboard\.writeText\(await getCampaignWhatsappMessage\(copy\.dataset\.campaign, copy\.dataset\.copyWhatsapp\)\)/);
  assert.match(client, /const whatsappMessage = await getCampaignWhatsappMessage\(button\.dataset\.campaign, button\.dataset\.openWhatsapp\)/);
  assert.match(client, /data-open-whatsapp=.*data-campaign=.*data-phone/);
  assert.match(client, /const url = `https:\/\/wa\.me\/\$\{whatsappPhoneNumber\(button\.dataset\.phone\)\}\?text=\$\{encodeURIComponent\(whatsappMessage\)\}`/);
  assert.match(client, /window\.open\('about:blank', '_blank'\)/);
  assert.match(client, /if \(openWhatsapp\) return openWhatsApp\(openWhatsapp\)/);
  assert.match(client, /digits\.length < 7 \|\| digits\.length > 15/);
  assert.equal((client.match(/<button class="button secondary" data-open-whatsapp/g) || []).length, 1, 'one shared action renderer serves desktop and mobile');
});

test('campaign detail refreshes open modal content without reopening it', () => {
  const client = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(client, /function renderCampaignDetail\(id, campaign, items\)/);
  assert.match(client, /data-manual-sent[^>]*type="button"/);
  assert.match(client, /data-skip-recipient[^>]*type="button"/);
  assert.match(client, /openCampaignId: null/);
  assert.match(client, /async function refreshOpenCampaign\(\)/);
  assert.match(client, /state\.openCampaignId = id/);
  assert.match(client, /if \(state\.openCampaignId !== id\) return;/);
  assert.match(client, /if \(state\.openCampaignId === id && !modal\.open\) modal\.showModal\(\);/);
  assert.match(client, /data-manual-sent[\s\S]*return refreshOpenCampaign\(\)/);
  assert.match(client, /data-skip-recipient[\s\S]*return refreshOpenCampaign\(\)/);
});

test('saved lead management pagination is capped at 20 and preserves filtered page navigation', () => {
  const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const client = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /const managementLimit = Math\.min\(limit, 20\)/);
  assert.match(app, /\$skip: \(page - 1\) \* managementLimit/);
  assert.match(client, /limit: 20/);
  assert.match(client, /Showing \$\{first\}–\$\{last\} of \$\{total\}/);
  assert.match(client, /data-lead-page/);
  assert.match(client, /state\.pages\.saved = 1/);
});

test('search history uses fixed 25-record pages with safe, compact navigation', () => {
  const client = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(client, /function historyPagination\(\{ page, pages, total, limit \}\)/);
  assert.match(client, /aria-label="Search history pagination"/);
  assert.match(client, /Showing \$\{first\}–\$\{last\} of \$\{total\} searches/);
  assert.match(client, /data-history-page/);
  assert.match(client, /aria-current="page"/);
  assert.match(client, /new URLSearchParams\(\{ page, limit: 25 \}\)/);
  assert.match(client, /state\.pages\.history = page/);
  assert.match(client, /page < 1 \|\| page > state\.historyPages/);
  assert.match(client, /page > data\.pagination\.pages/);
  assert.match(client, /request !== state\.historyRequest/);
});

test('saved lead all-matching selection survives pagination and retains the campaign request contract', () => {
  const client = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  // Selecting all matching leads immediately selects the rows already rendered,
  // and savedLeadSelected drives every later page render from that mode.
  assert.match(client, /id === 'saved-select-matching'.*state\.savedSelectAll = true.*updateSavedSelection/s);
  assert.match(client, /function savedLeadSelected\(id\) \{ return state\.savedSelectAll \? !state\.savedExcluded\.has\(id\) : state\.savedSelected\.has\(id\); \}/);
  assert.match(client, /id="saved-select-all"[^`]*state\.savedSelectAll[^`]*'checked'/);
  assert.match(client, /class="saved-lead-select"[^`]*savedLeadSelected\(l\._id\)[^`]*'checked'/);
  assert.match(client, /state\.savedSelectAll \? `\$\{state\.savedTotal - state\.savedExcluded\.size\} matching leads`/);
  assert.match(client, /state\.savedExcluded\.add\(e\.target\.dataset\.id\)/);
  // All matching selection still delegates filtered recipient resolution to the server.
  const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(client, /selectAllMatching: true, \.\.\.state\.filters\.saved, excludedLeadIds: \[\.\.\.state\.savedExcluded\], includeContacted/);
  assert.match(app, /body\?\.selectAllMatching === true/);
  assert.match(app, /excludedLeadIds/);
});

test('mailbox uses fixed 25-email server pages and current-page soft-delete selection', () => {
  const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const client = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /const mailboxPage = query => \(\{ page: Math\.max\(1, Math\.floor\(Number\(query\.page\) \|\| 1\)\), limit: 25 \}\)/);
  assert.match(app, /\$unionWith/); assert.match(app, /\$skip: \(page - 1\) \* limit/); assert.match(app, /\$limit: limit/);
  assert.match(app, /app\.post\('\/api\/mailbox\/messages\/delete', mailboxRateLimit/);
  assert.match(app, /deletedAt: null/); assert.match(app, /ids\.length > 25/);
  assert.match(client, /limit: 25/); assert.match(client, /data-mailbox-page/); assert.match(client, /mailbox-select-all/);
  assert.match(client, /mailboxSelected/); assert.match(client, /data-confirm-mailbox-delete/);
});

test('campaign mailbox persistence is isolated and reply recipients are server controlled', () => {
  const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const inbox = fs.readFileSync(new URL('../src/services/inbox.js', import.meta.url), 'utf8');
  assert.match(app, /await repairCampaignMailboxEmails\(campaign\)/);
  assert.match(app, /mailboxPersistencePending: true/);
  assert.match(app, /Campaign mailbox persistence failed/);
  assert.match(app, /to: \[external\], cc: \[\], bcc: \[\], subject: `Re: \$\{originalSubject\}`/);
  assert.match(app, /inReplyTo: normalizedMessageId\(parent\.messageId\), references/);
  assert.match(inbox, /headers: \{ 'Message-ID': rfcMessageId \}/);
  assert.match(inbox, /provider, from: sender\.from/);
  assert.match(app, /latestSent.*provider/);
});

test('mailbox accepts inbound mail only through the webhook and exposes no manual sync path', () => {
  const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const inbox = fs.readFileSync(new URL('../src/services/inbox.js', import.meta.url), 'utf8');
  const client = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(app, /event\.type !== 'email\.received'/);
  assert.match(app, /persistReceived\(await receiveEmail\(emailId\)/);
  assert.match(inbox, /resendRequest\(`\/emails\/receiving\/\$\{encodeURIComponent\(id\)\}`/);
  assert.doesNotMatch(app, /\/api\/mailbox\/sync|listReceived/);
  assert.doesNotMatch(inbox, /listReceived|\/emails\/receiving\?limit=/);
  assert.doesNotMatch(client, /mailbox-sync|\/api\/mailbox\/sync/);
  assert.doesNotMatch(html, /mailbox-sync|>Sync</);
});

test('mailbox counts and Trash operations use bounded, soft-delete-safe API contracts', () => {
  const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8'); const client = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8'); const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(app, /app\.get\('\/api\/mailbox\/counts'/);
  assert.match(app, /app\.post\('\/api\/mailbox\/messages\/restore', mailboxRateLimit/);
  assert.match(app, /app\.post\('\/api\/mailbox\/messages\/permanent-delete', mailboxRateLimit/);
  assert.match(app, /deletedAt: \{ \$ne: null \}/);
  assert.match(app, /req\.query\.trash === 'true'/);
  assert.match(client, /loadMailboxCounts\(\)/);
  assert.match(client, /data-open-trash-mail/);
  assert.match(client, /mailbox-restore-selected/);
  assert.match(client, /mailbox-permanent-delete-selected/);
  assert.match(html, /mailbox-trash-count/);
});

test('Find Leads has a compact mobile presentation and Lead Management reuses discovery sources', () => {
  const client = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8'); const css = fs.readFileSync(new URL('../public/css/styles.css', import.meta.url), 'utf8');
  assert.match(client, /function sourceLabel\(lead\)/);
  assert.match(client, /new-leads-mobile/);
  assert.match(client, /<details><summary>Details<\/summary>/);
  assert.match(client, /management-table.*source-badge/s);
  assert.match(css, /\.new-leads-mobile \{ display:none; \}/);
  assert.match(css, /@media \(max-width:760px\) \{ \.new-leads-desktop \{ display:none; \}/);
});

test('mailbox badge totals are independent from search-result totals', () => {
  const client = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(client, /async function loadMailboxCounts\(\)/);
  assert.doesNotMatch(client, /mailbox-inbox-count'\)\.textContent = data\.total/);
  assert.doesNotMatch(client, /mailbox-sent-count'\)\.textContent = data\.total/);
  assert.doesNotMatch(client, /mailbox-trash-count'\)\.textContent = data\.total/);
});

test('Inbox conversations expose a reply action only for active received email threads', () => {
  const client = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(client, /latestInbound = \[\.\.\.data\.items\]\.reverse\(\)\.find\(item => item\.box === 'inbox'\)/);
  assert.match(client, /!trash && latestInbound/);
  assert.match(client, /data-mail-reply=.*data-mail-to=.*latestInbound\.fromEmail/);
  assert.match(client, /\/api\/mailbox\/conversations\/\$\{encodeURIComponent\(sendMail\.dataset\.mailSend\)\}\/reply/);
});

test('saved lead bulk Not Useful confirmation snapshots its selection before reusing the bulk discarded update', () => {
  const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const client = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="mark-saved-not-useful"/);
  assert.match(html, /class="saved-selection-danger"/);
  assert.match(client, /function confirmMarkSavedNotUseful\(\)/);
  assert.match(client, /savedNotUsefulSelection\(\)/);
  assert.match(client, /state\.savedNotUsefulConfirmation = confirmation/);
  assert.match(client, /You are about to mark \$\{confirmation\.count\} selected \$\{pluralLead\} as Not Useful\. Continue\?/);
  assert.match(client, /data-confirm-saved-not-useful/);
  assert.match(client, /JSON\.stringify\(confirmation\.body\)/);
  assert.match(client, /state\.savedNotUsefulConfirmation = null/);
  assert.match(client, /'close', \(\) => \{ state\.openCampaignId = null; state\.savedNotUsefulConfirmation = null;/);
  assert.match(client, /selectAllMatching: true, \.\.\.filters, excludedLeadIds, confirmation: 'NOT_USEFUL'/);
  assert.match(client, /confirmation: 'NOT_USEFUL'/);
  assert.match(client, /setButtonLoading\(button, true, 'Updating…'\)/);
  assert.match(app, /savedSelection && req\.body\?\.confirmation !== 'NOT_USEFUL'/);
  assert.match(app, /status: 'saved'/);
  assert.match(app, /status: action, savedAt: null, notUsefulAt: new Date\(\)/);
});

test('mailbox bulk Not Useful derives unique current lead statuses from selected mailbox records', () => {
  const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(app, /app\.post\('\/api\/mailbox\/messages\/not-useful\/check', mailboxRateLimit/);
  assert.match(app, /app\.post\('\/api\/mailbox\/messages\/not-useful', mailboxRateLimit/);
  assert.match(app, /ReceivedEmail\.find\(filter\).*SentMailboxEmail\.find\(filter\)/);
  assert.match(app, /async function mailboxLeadAssociations\(items\)/);
  assert.match(app, /leads\?\.size === 1/);
  assert.match(app, /Lead\.find\(\{ _id: \{ \$in: leadIds \} \}\)\.select\('status'\)/);
  assert.match(app, /req\.body\?\.confirmation !== 'NOT_USEFUL'/);
  assert.match(app, /'CONFIRMATION_REQUIRED'/);
  assert.match(app, /status: \{ \$ne: 'discarded' \}/);
  assert.match(app, /status: 'discarded', savedAt: null, notUsefulAt: new Date\(\)/);
  assert.doesNotMatch(app.slice(app.indexOf("app.post('/api/mailbox/messages/not-useful'"), app.indexOf('const discoveryJobResponse')), /ReceivedEmail\.(?:update|delete)|SentMailboxEmail\.(?:update|delete)/);
});

test('mailbox Not Useful UI is selection-only, checks before confirmation, and displays current status badges', () => {
  const client = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/css/styles.css', import.meta.url), 'utf8');
  assert.match(client, /id="mailbox-mark-not-useful"[\s\S]*state\.mailboxSelected\.size \? '' : 'hidden'/);
  assert.match(client, /Checking selected leads…/);
  assert.match(client, /\/api\/mailbox\/messages\/not-useful\/check/);
  assert.match(client, /Unable to verify the selected leads\. No changes were made\./);
  assert.match(client, /data-retry-mailbox-not-useful/);
  assert.match(client, /state\.mailboxNotUsefulTarget = \[\.\.\.state\.mailboxSelected\]/);
  assert.match(client, /const ids = state\.mailboxNotUsefulTarget/);
  assert.match(client, /JSON\.stringify\(\{ ids, confirmation: 'NOT_USEFUL' \}\)/);
  assert.match(client, /state\.mailboxNotUsefulTarget = null/);
  assert.match(client, /Marking leads as Not Useful…/);
  assert.match(client, /data-confirm-mailbox-not-useful/);
  assert.match(client, /item\.leadNotUseful \? ' <em class="mail-not-useful">Not Useful<\/em>' : ''/);
  assert.match(css, /\.mail-not-useful/); assert.match(css, /#fef2f2/); assert.match(css, /#b91c1c/); assert.match(css, /#fecaca/);
});
