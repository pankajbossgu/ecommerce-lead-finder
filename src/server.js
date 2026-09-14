import app from './app.js';
import { connectDatabase, env } from './config.js';
import { SearchJob } from './models.js';
import { logger } from './utils.js';

try {
  await connectDatabase();
  await SearchJob.updateMany({ status: { $in: ['queued', 'running'] }, updatedAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) } }, { $set: { status: 'failed', errorMessage: 'Discovery did not complete. Please start a new search.', completedAt: new Date() } });
  app.listen(env.port, () => logger.info(`Server listening on port ${env.port}`));
} catch { logger.error('Startup failed: database connection is unavailable.'); process.exit(1); }
