import mongoose from 'mongoose';

const leadSchema = new mongoose.Schema({
  businessName: { type: String, required: true, trim: true, maxlength: 200 },
  domain: { type: String, required: true, unique: true, lowercase: true, trim: true },
  website: { type: String, required: true }, email: { type: String, required: true, lowercase: true, trim: true }, phone: { type: String, default: null },
  status: { type: String, enum: ['pending', 'saved', 'discarded'], default: 'pending', index: true },
  searchJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'SearchJob', required: true },
  category: { type: String, required: true }, location: { type: String, required: true }, keywords: { type: String, default: '' }, isEcommerce: { type: Boolean, required: true },
  websiteSourceUrl: { type: String, default: null }, emailSourceUrl: { type: String, default: null }, phoneSourceUrl: { type: String, default: null },
  discoverySource: { type: String, default: 'gemini_google_search' }, discoveredAt: { type: Date, default: Date.now, index: true }
}, { timestamps: true, versionKey: false });
leadSchema.index({ email: 1 });
leadSchema.index({ searchJobId: 1, status: 1 });

const jobSchema = new mongoose.Schema({
  category: String, location: String, keywords: { type: String, default: '' }, requestedCount: Number,
  status: { type: String, enum: ['queued', 'running', 'completed', 'failed', 'cancelled'], default: 'queued', index: true },
  foundCount: { type: Number, default: 0 }, duplicateCount: { type: Number, default: 0 }, rejectedCount: { type: Number, default: 0 },
  startedAt: { type: Date, default: null }, completedAt: { type: Date, default: null }, errorMessage: { type: String, default: null }
}, { timestamps: true, versionKey: false });
jobSchema.index({ createdAt: -1 });

const historySchema = new mongoose.Schema({
  searchJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'SearchJob', unique: true, sparse: true },
  category: String, location: String, keywords: { type: String, default: '' }, requestedCount: Number, foundCount: Number,
  duplicateCount: { type: Number, default: 0 }, rejectedCount: { type: Number, default: 0 },
  status: { type: String, enum: ['completed', 'failed', 'cancelled'], default: 'completed' }
}, { timestamps: true, versionKey: false });
historySchema.index({ createdAt: -1 });

export const Lead = mongoose.model('Lead', leadSchema);
export const SearchJob = mongoose.model('SearchJob', jobSchema);
export const SearchHistory = mongoose.model('SearchHistory', historySchema);

// A single fixed document provides an atomic, MongoDB-backed ownership record
// for the one unresolved discovery session allowed by the product.
const discoveryStateSchema = new mongoose.Schema({
  _id: { type: String, default: 'current' },
  currentJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'SearchJob', default: null }
}, { timestamps: true, versionKey: false });
export const DiscoveryState = mongoose.model('DiscoveryState', discoveryStateSchema);
