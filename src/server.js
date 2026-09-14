import app from './app.js';
import { connectDatabase, env } from './config.js';
import { logger } from './utils.js';

try {
  await connectDatabase();
  app.listen(env.port, () => logger.info(`Server listening on port ${env.port}`));
} catch { logger.error('Startup failed: database connection is unavailable.'); process.exit(1); }
