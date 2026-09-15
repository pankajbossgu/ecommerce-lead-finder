import 'dotenv/config';
import mongoose from 'mongoose';
import { isValidPublicEmail, normalizeEmail } from './utils.js';

const number = (name, fallback) => { const value = Number(process.env[name] ?? fallback); return Number.isFinite(value) ? value : fallback; };
const databaseName = 'ecommerce_lead_finder';
export const env = Object.freeze({ nodeEnv: process.env.NODE_ENV || 'development', port: number('PORT', 3000), mongoUri: process.env.MONGODB_URI || '', geminiApiKey: process.env.GEMINI_API_KEY || '', resendApiKey: process.env.RESEND_API_KEY || '', resendWebhookSecret: process.env.RESEND_WEBHOOK_SECRET || '', emailFrom: process.env.EMAIL_FROM || '', emailReplyTo: process.env.EMAIL_REPLY_TO || '', appOrigin: process.env.APP_ORIGIN || '', rateLimitWindowMs: number('DISCOVERY_RATE_LIMIT_WINDOW_MS', 900000), rateLimitMax: number('DISCOVERY_RATE_LIMIT_MAX', 10), discoveryMaxAttempts: Math.min(number('DISCOVERY_MAX_ATTEMPTS', 4), 8), discoveryBatchSize: Math.min(number('DISCOVERY_BATCH_SIZE', 30), 50) });
let connectPromise; let indexesMigrated = false;
async function migrateLegacyDomainIndex() {
  if (indexesMigrated) return;
  const indexes = await mongoose.connection.collection('leads').indexes().catch(() => []);
  const legacy = indexes.find(index => index.name === 'domain_1' && index.unique && !index.partialFilterExpression);
  // Older builds used domain+status, allowing one Saved and one Not Useful copy.
  // The resolved-domain key must be domain-only for the cross-status rule.
  const outdatedResolved = indexes.find(index => index.name === 'resolved_domain_unique' && JSON.stringify(index.key) !== JSON.stringify({ domain: 1 }));
  if (legacy) await mongoose.connection.collection('leads').dropIndex(legacy.name);
  if (outdatedResolved) await mongoose.connection.collection('leads').dropIndex(outdatedResolved.name);
  // Reserve one deterministic identity for every pre-existing valid email
  // before creating the unique index. We retain every legacy lead (including
  // conflicting records) rather than deleting or rewriting business data.
  // The earliest document owns the indexed key; later conflicts retain their
  // original email and are marked for administrative review.
  const leads = mongoose.connection.collection('leads');
  const claimedEmails = new Map();
  const operations = [];
  const cursor = leads.find({}, { projection: { _id: 1, email: 1 } }).sort({ createdAt: 1, _id: 1 });
  for await (const legacyLead of cursor) {
    const email = normalizeEmail(legacyLead.email);
    const validEmail = isValidPublicEmail(email);
    const ownerId = validEmail ? claimedEmails.get(email) : null;
    if (validEmail && !ownerId) {
      claimedEmails.set(email, legacyLead._id);
      operations.push({ updateOne: { filter: { _id: legacyLead._id }, update: { $set: { email, emailNormalized: email }, $unset: { legacyEmailDuplicateOf: '' } } } });
    } else if (validEmail) {
      operations.push({ updateOne: { filter: { _id: legacyLead._id }, update: { $set: { email, legacyEmailDuplicateOf: ownerId }, $unset: { emailNormalized: '' } } } });
    } else {
      operations.push({ updateOne: { filter: { _id: legacyLead._id }, update: { $unset: { emailNormalized: '', legacyEmailDuplicateOf: '' } } } });
    }
    if (operations.length === 500) { await leads.bulkWrite(operations); operations.length = 0; }
  }
  if (operations.length) await leads.bulkWrite(operations);
  const emailIndex = (await leads.indexes().catch(() => [])).find(index => index.name === 'normalized_email_unique');
  if (emailIndex && (!emailIndex.unique || JSON.stringify(emailIndex.key) !== JSON.stringify({ emailNormalized: 1 }))) await leads.dropIndex(emailIndex.name);
  // Activity history survives campaign deletion. Backfill its canonical email
  // key so it can continue to suppress outreach even after a lead is removed.
  const activities = mongoose.connection.collection('outreachactivities');
  const activityOps = [];
  const activityCursor = activities.find({ channel: 'email' }, { projection: { _id: 1, recipient: 1 } });
  for await (const activity of activityCursor) {
    const recipientNormalized = normalizeEmail(activity.recipient);
    activityOps.push({ updateOne: { filter: { _id: activity._id }, update: recipientNormalized ? { $set: { recipientNormalized } } : { $unset: { recipientNormalized: '' } } } });
    if (activityOps.length === 500) { await activities.bulkWrite(activityOps); activityOps.length = 0; }
  }
  if (activityOps.length) await activities.bulkWrite(activityOps);
  await Promise.all([Lead.createIndexes(), ReceivedEmail.createIndexes(), SentMailboxEmail.createIndexes()]);
  indexesMigrated = true;
}
export async function connectDatabase() {
  if (mongoose.connection.readyState === 1) { await migrateLegacyDomainIndex(); return mongoose.connection; }
  if (!env.mongoUri) throw new Error('MONGODB_URI is not configured');
  // Index creation is performed by the migration below, after legacy email
  // identities are made safe for the partial unique index.
  if (!connectPromise) connectPromise = mongoose.connect(env.mongoUri, { dbName: databaseName, serverSelectionTimeoutMS: 8000, autoIndex: false }).catch((error) => { connectPromise = undefined; throw error; });
  const connection = await connectPromise; await migrateLegacyDomainIndex(); return connection;
}

const leadSchema = new mongoose.Schema({
  businessName: { type: String, required: true, trim: true, maxlength: 200 },
  // This is deliberately not globally unique: unresolved leads can be cleared and rediscovered.
  domain: { type: String, required: true, lowercase: true, trim: true },
  website: { type: String, required: true }, email: { type: String, default: null, set: normalizeEmail }, emailNormalized: { type: String, default: null, set: normalizeEmail }, legacyEmailDuplicateOf: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', default: null }, phone: { type: String, default: null },
  status: { type: String, enum: ['new', 'saved', 'discarded'], default: 'new', index: true },
  searchJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'SearchJob', default: null, index: true },
  category: { type: String, required: true }, location: { type: String, required: true }, notes: { type: String, default: '', maxlength: 2000 }, keywords: { type: String, default: '' }, isEcommerce: { type: Boolean, required: true },
  websiteSourceUrl: { type: String, default: null }, emailSourceUrl: { type: String, default: null }, phoneSourceUrl: { type: String, default: null }, discoverySource: { type: String, default: 'gemini_google_search' }, discoverySources: { type: [{ type: String, enum: ['website', 'social'] }], default: [] }, socialProfiles: { instagram: { type: String, default: null }, facebook: { type: String, default: null }, linkedin: { type: String, default: null } }, sourceUrls: { type: [String], default: [] }, discoveredAt: { type: Date, default: Date.now, index: true },
  // These are lifecycle timestamps, intentionally independent from discovery time.
  savedAt: { type: Date, default: null, index: true },
  notUsefulAt: { type: Date, default: null, index: true }
}, { timestamps: true, versionKey: false });
leadSchema.pre('validate', function normalizeLeadEmail(next) {
  this.email = normalizeEmail(this.email);
  this.emailNormalized = isValidPublicEmail(this.email) ? this.email : null;
  if (this.status === 'saved' && !isValidPublicEmail(this.email)) this.invalidate('email', 'A saved lead requires a valid public business email');
  next();
});
leadSchema.index({ domain: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['saved', 'discarded'] } }, name: 'resolved_domain_unique' });
leadSchema.index({ emailNormalized: 1 }, { unique: true, partialFilterExpression: { emailNormalized: { $type: 'string' } }, name: 'normalized_email_unique' });
leadSchema.index({ searchJobId: 1, domain: 1 }, { unique: true, partialFilterExpression: { searchJobId: { $type: 'objectId' } }, name: 'job_domain_unique' });
leadSchema.index({ searchJobId: 1, status: 1, discoveredAt: -1 });
leadSchema.index({ status: 1, savedAt: -1 });
leadSchema.index({ status: 1, notUsefulAt: -1 });
leadSchema.index({ status: 1, discoveredAt: -1, searchJobId: 1 });
leadSchema.index({ email: 1 });

const jobSchema = new mongoose.Schema({
  category: String, location: String, keywords: { type: String, default: '' }, requestedCount: Number, mode: { type: String, enum: ['hybrid', 'website', 'social'], default: 'hybrid' },
  discoveryProgress: { website: { status: { type: String, default: 'waiting' }, candidates: { type: Number, default: 0 }, error: { type: String, default: null } }, social: { status: { type: String, default: 'waiting' }, candidates: { type: Number, default: 0 }, error: { type: String, default: null } }, merging: { type: String, default: 'waiting' }, validation: { type: String, default: 'waiting' } },
  status: { type: String, enum: ['queued', 'running', 'completed', 'failed', 'cancelled'], default: 'queued', index: true }, openLock: { type: String, default: 'discovery' },
  foundCount: { type: Number, default: 0 }, duplicateCount: { type: Number, default: 0 }, rejectedCount: { type: Number, default: 0 },
  attempts: { type: Number, default: 0 },
  // Persist the model response and cursor so a serverless retry resumes the
  // exact variation/candidate rather than regenerating a batch.
  checkpoint: { variationIndex: { type: Number, default: 0 }, candidateIndex: { type: Number, default: 0 }, batchId: { type: String, default: null }, candidates: { type: [mongoose.Schema.Types.Mixed], default: [] }, discoveredDomains: { type: [String], default: [] } },
  workerToken: { type: String, default: null }, workerLeaseExpiresAt: { type: Date, default: null },
  startedAt: { type: Date, default: null }, completedAt: { type: Date, default: null }, errorMessage: { type: String, default: null }
}, { timestamps: true, versionKey: false });
jobSchema.index({ createdAt: -1 }); jobSchema.index({ status: 1, workerLeaseExpiresAt: 1 }); jobSchema.index({ openLock: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['queued', 'running'] } }, name: 'one_active_discovery_job' });
const historySchema = new mongoose.Schema({ category: String, location: String, keywords: { type: String, default: '' }, requestedCount: Number, mode: { type: String, enum: ['hybrid', 'website', 'social'], default: 'hybrid' },
  discoveryProgress: { website: { status: { type: String, default: 'waiting' }, candidates: { type: Number, default: 0 }, error: { type: String, default: null } }, social: { status: { type: String, default: 'waiting' }, candidates: { type: Number, default: 0 }, error: { type: String, default: null } }, merging: { type: String, default: 'waiting' }, validation: { type: String, default: 'waiting' } }, foundCount: Number }, { timestamps: true, versionKey: false }); historySchema.index({ createdAt: -1 });
const templateSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  type: { type: String, required: true, enum: ['email', 'whatsapp'], index: true },
  subject: { type: String, default: null, maxlength: 200 },
  body: { type: String, required: true, maxlength: 10000 }
}, { timestamps: true, versionKey: false });
templateSchema.index({ type: 1, updatedAt: -1 });
const campaignSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 }, channels: [{ type: String, enum: ['email', 'whatsapp'] }],
  emailTemplateId: { type: mongoose.Schema.Types.ObjectId, ref: 'OutreachTemplate', default: null }, whatsappTemplateId: { type: mongoose.Schema.Types.ObjectId, ref: 'OutreachTemplate', default: null },
  status: { type: String, enum: ['draft', 'ready', 'sending', 'completed', 'paused', 'failed'], default: 'draft', index: true },
  recipientCount: { type: Number, default: 0 }, emailCount: { type: Number, default: 0 }, whatsappCount: { type: Number, default: 0 }, sentCount: { type: Number, default: 0 }, failedCount: { type: Number, default: 0 }, pendingCount: { type: Number, default: 0 },
  businessCount: { type: Number, default: 0 }, emailSentCount: { type: Number, default: 0 }, emailFailedCount: { type: Number, default: 0 }, emailPendingCount: { type: Number, default: 0 }, whatsappSentCount: { type: Number, default: 0 }, processedCount: { type: Number, default: 0 }, currentBatch: { type: Number, default: 0 }, currentBatchProcessed: { type: Number, default: 0 }, currentBatchSize: { type: Number, default: 0 }, whatsappPendingCount: { type: Number, default: 0 }, whatsappSkippedCount: { type: Number, default: 0 },
  startedAt: Date, completedAt: Date
}, { timestamps: true, versionKey: false });
campaignSchema.index({ status: 1, updatedAt: -1 });
const recipientSchema = new mongoose.Schema({
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true }, leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
  channel: { type: String, required: true, enum: ['email', 'whatsapp'] }, recipient: { type: String, required: true, maxlength: 254 }, templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'OutreachTemplate', required: true },
  status: { type: String, enum: ['pending', 'ready', 'sending', 'sent', 'failed', 'skipped', 'manual_sent'], default: 'ready', index: true },
  sentAt: Date, failedAt: Date, failureReason: { type: String, maxlength: 500 }, providerMessageId: { type: String, maxlength: 200 }, attempts: { type: Number, default: 0 }, idempotencyKey: { type: String, required: true, unique: true, maxlength: 200 }, batchKey: { type: String, default: null, index: true }, batchNumber: { type: Number, default: null }, sendingLeaseExpiresAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false });
recipientSchema.index({ campaignId: 1, leadId: 1, channel: 1 }, { unique: true }); recipientSchema.index({ status: 1, sentAt: -1 });
const activitySchema = new mongoose.Schema({
  leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true, index: true }, campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true }, channel: { type: String, enum: ['email', 'whatsapp'], required: true, index: true }, templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'OutreachTemplate', default: null }, recipient: { type: String, required: true }, recipientNormalized: { type: String, default: null, set: normalizeEmail }, subject: { type: String, default: null, maxlength: 200 }, status: { type: String, enum: ['sent', 'manual_sent', 'failed', 'skipped'], required: true, index: true }, sentAt: Date, failedAt: Date, failureReason: { type: String, maxlength: 500 }, providerMessageId: { type: String, maxlength: 200 }, nextFollowUpAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false });
activitySchema.pre('validate', function normalizeActivityRecipient(next) { this.recipientNormalized = this.channel === 'email' ? normalizeEmail(this.recipient) : null; next(); });
activitySchema.index({ leadId: 1, sentAt: -1, createdAt: -1 }); activitySchema.index({ campaignId: 1, createdAt: -1 }); activitySchema.index({ channel: 1, status: 1, sentAt: -1 }); activitySchema.index({ channel: 1, recipientNormalized: 1, status: 1 });
const mailboxFields = {
  from: { type: String, required: true, maxlength: 500 }, to: { type: [String], default: [] }, cc: { type: [String], default: [] }, bcc: { type: [String], default: [] }, replyTo: { type: [String], default: [] },
  subject: { type: String, default: '', maxlength: 500 }, text: { type: String, default: '', maxlength: 200000 }, html: { type: String, default: '', maxlength: 500000 }, headers: { type: mongoose.Schema.Types.Mixed, default: {} }, messageId: { type: String, default: null, index: true }, inReplyTo: { type: String, default: null, index: true }, references: { type: [String], default: [] }, conversationId: { type: String, required: true, index: true }, attachments: { type: [mongoose.Schema.Types.Mixed], default: [] }, deletedAt: { type: Date, default: null, index: true }
};
const receivedEmailSchema = new mongoose.Schema({ ...mailboxFields, resendEmailId: { type: String, required: true, unique: true, index: true, maxlength: 200 }, webhookEventId: { type: String, default: null, index: true, maxlength: 200 }, fromEmail: { type: String, required: true, index: true, maxlength: 254 }, leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', default: null }, receivedAt: { type: Date, required: true, default: Date.now, index: true }, readAt: { type: Date, default: null, index: true } }, { timestamps: true, versionKey: false });
receivedEmailSchema.index({ deletedAt: 1, receivedAt: -1 }); receivedEmailSchema.index({ conversationId: 1, receivedAt: -1 });
receivedEmailSchema.index({ webhookEventId: 1 }, { unique: true, partialFilterExpression: { webhookEventId: { $type: 'string' } }, name: 'resend_webhook_delivery_unique' });
const sentMailboxEmailSchema = new mongoose.Schema({ ...mailboxFields, resendEmailId: { type: String, default: null, index: true, maxlength: 200 }, providerMessageId: { type: String, default: null, index: true, maxlength: 200 }, campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', default: null, index: true }, campaignRecipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'CampaignRecipient', default: null, index: true }, leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', default: null, index: true }, source: { type: String, enum: ['direct', 'campaign'], default: 'direct', index: true }, sentAt: { type: Date, required: true, default: Date.now, index: true }, status: { type: String, enum: ['sent', 'failed'], default: 'sent' } }, { timestamps: true, versionKey: false });
sentMailboxEmailSchema.index({ deletedAt: 1, sentAt: -1 }); sentMailboxEmailSchema.index({ conversationId: 1, sentAt: -1 });
sentMailboxEmailSchema.index({ campaignRecipientId: 1 }, { unique: true, partialFilterExpression: { campaignRecipientId: { $type: 'objectId' } }, name: 'campaign_mailbox_recipient_unique' });
export const Lead = mongoose.model('Lead', leadSchema); export const SearchJob = mongoose.model('SearchJob', jobSchema); export const SearchHistory = mongoose.model('SearchHistory', historySchema); export const OutreachTemplate = mongoose.model('OutreachTemplate', templateSchema); export const Campaign = mongoose.model('Campaign', campaignSchema); export const CampaignRecipient = mongoose.model('CampaignRecipient', recipientSchema); export const OutreachActivity = mongoose.model('OutreachActivity', activitySchema); export const ReceivedEmail = mongoose.model('ReceivedEmail', receivedEmailSchema); export const SentMailboxEmail = mongoose.model('SentMailboxEmail', sentMailboxEmailSchema);
