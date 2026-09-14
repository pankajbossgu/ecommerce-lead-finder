import 'dotenv/config';
import mongoose from 'mongoose';

const number = (name, fallback) => { const value = Number(process.env[name] ?? fallback); return Number.isFinite(value) ? value : fallback; };
const databaseName = 'ecommerce_lead_finder';
export const env = Object.freeze({ nodeEnv: process.env.NODE_ENV || 'development', port: number('PORT', 3000), mongoUri: process.env.MONGODB_URI || '', geminiApiKey: process.env.GEMINI_API_KEY || '', appOrigin: process.env.APP_ORIGIN || '', rateLimitWindowMs: number('DISCOVERY_RATE_LIMIT_WINDOW_MS', 900000), rateLimitMax: number('DISCOVERY_RATE_LIMIT_MAX', 10), discoveryMaxAttempts: Math.min(number('DISCOVERY_MAX_ATTEMPTS', 4), 8), discoveryBatchSize: Math.min(number('DISCOVERY_BATCH_SIZE', 30), 50) });
let connectPromise; let indexesMigrated = false;
async function migrateLegacyDomainIndex() {
  if (indexesMigrated) return;
  const indexes = await mongoose.connection.collection('leads').indexes().catch(() => []);
  const legacy = indexes.find(index => index.name === 'domain_1' && index.unique && !index.partialFilterExpression);
  if (legacy) await mongoose.connection.collection('leads').dropIndex(legacy.name);
  await Lead.createIndexes();
  indexesMigrated = true;
}
export async function connectDatabase() {
  if (mongoose.connection.readyState === 1) { await migrateLegacyDomainIndex(); return mongoose.connection; }
  if (!env.mongoUri) throw new Error('MONGODB_URI is not configured');
  if (!connectPromise) connectPromise = mongoose.connect(env.mongoUri, { dbName: databaseName, serverSelectionTimeoutMS: 8000 }).catch((error) => { connectPromise = undefined; throw error; });
  const connection = await connectPromise; await migrateLegacyDomainIndex(); return connection;
}

const leadSchema = new mongoose.Schema({
  businessName: { type: String, required: true, trim: true, maxlength: 200 },
  // This is deliberately not globally unique: unresolved leads can be cleared and rediscovered.
  domain: { type: String, required: true, lowercase: true, trim: true },
  website: { type: String, required: true }, email: { type: String, required: true, lowercase: true, trim: true }, phone: { type: String, default: null },
  status: { type: String, enum: ['new', 'saved', 'discarded'], default: 'new', index: true },
  searchJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'SearchJob', default: null, index: true },
  category: { type: String, required: true }, location: { type: String, required: true }, keywords: { type: String, default: '' }, isEcommerce: { type: Boolean, required: true },
  websiteSourceUrl: { type: String, default: null }, emailSourceUrl: { type: String, default: null }, phoneSourceUrl: { type: String, default: null }, discoverySource: { type: String, default: 'gemini_google_search' }, discoveredAt: { type: Date, default: Date.now, index: true }
}, { timestamps: true, versionKey: false });
leadSchema.index({ domain: 1, status: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['saved', 'discarded'] } }, name: 'resolved_domain_unique' });
leadSchema.index({ searchJobId: 1, domain: 1 }, { unique: true, partialFilterExpression: { searchJobId: { $type: 'objectId' } }, name: 'job_domain_unique' });
leadSchema.index({ searchJobId: 1, status: 1, discoveredAt: -1 });
leadSchema.index({ email: 1 });

const jobSchema = new mongoose.Schema({
  category: String, location: String, keywords: { type: String, default: '' }, requestedCount: Number,
  status: { type: String, enum: ['queued', 'running', 'completed', 'failed', 'cancelled'], default: 'queued', index: true }, openLock: { type: String, default: 'discovery' },
  foundCount: { type: Number, default: 0 }, duplicateCount: { type: Number, default: 0 }, rejectedCount: { type: Number, default: 0 },
  attempts: { type: Number, default: 0 },
  // Persist the model response and cursor so a serverless retry resumes the
  // exact variation/candidate rather than regenerating a batch.
  checkpoint: { variationIndex: { type: Number, default: 0 }, candidateIndex: { type: Number, default: 0 }, batchId: { type: String, default: null }, candidates: { type: [mongoose.Schema.Types.Mixed], default: [] } },
  workerToken: { type: String, default: null }, workerLeaseExpiresAt: { type: Date, default: null },
  startedAt: { type: Date, default: null }, completedAt: { type: Date, default: null }, errorMessage: { type: String, default: null }
}, { timestamps: true, versionKey: false });
jobSchema.index({ createdAt: -1 }); jobSchema.index({ status: 1, workerLeaseExpiresAt: 1 }); jobSchema.index({ openLock: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['queued', 'running'] } }, name: 'one_active_discovery_job' });
const historySchema = new mongoose.Schema({ category: String, location: String, keywords: { type: String, default: '' }, requestedCount: Number, foundCount: Number }, { timestamps: true, versionKey: false }); historySchema.index({ createdAt: -1 });
export const Lead = mongoose.model('Lead', leadSchema); export const SearchJob = mongoose.model('SearchJob', jobSchema); export const SearchHistory = mongoose.model('SearchHistory', historySchema);
