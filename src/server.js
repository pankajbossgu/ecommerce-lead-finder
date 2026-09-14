import app from './app.js';
import { connectDatabase, env } from './config.js';
import { logger } from './utils.js';
import { recoverStaleDiscoveries } from './services.js';

try {
  await connectDatabase();
  app.listen(env.port, () => logger.info(`Server listening on port ${env.port}`));
  // Local/long-lived deployments also reclaim expired serverless-style leases.
  setInterval(() => { void recoverStaleDiscoveries(); }, 30_000).unref();
} catch { logger.error('Startup failed: database connection is unavailable.'); process.exit(1); }
