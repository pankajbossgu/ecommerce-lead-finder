import 'dotenv/config';
import mongoose from 'mongoose';

const number = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
};

export const databaseName = 'ecommerce_lead_finder';

export const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: number('PORT', 3000),
  mongoUri: process.env.MONGODB_URI || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  appOrigin: process.env.APP_ORIGIN || '',
  rateLimitWindowMs: number('DISCOVERY_RATE_LIMIT_WINDOW_MS', 900000),
  rateLimitMax: number('DISCOVERY_RATE_LIMIT_MAX', 10),
  discoveryMaxAttempts: Math.min(number('DISCOVERY_MAX_ATTEMPTS', 4), 8),
  discoveryBatchSize: Math.min(number('DISCOVERY_BATCH_SIZE', 30), 50)
});

let connectPromise;
export async function connectDatabase() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (!env.mongoUri) throw new Error('MONGODB_URI is not configured');
  if (!connectPromise) {
    connectPromise = mongoose.connect(env.mongoUri, { dbName: databaseName, serverSelectionTimeoutMS: 8000 })
      .catch((error) => { connectPromise = undefined; throw error; });
  }
  return connectPromise;
}
