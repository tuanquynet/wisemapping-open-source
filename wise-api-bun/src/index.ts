import { app } from "./app.ts";
import { config } from "./config.ts";
import { db } from "./db/client.bun.ts";
import * as lockManager from "./services/lockManager.ts";
import { logger } from "./util/logger.ts";

const server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
});

logger.info(
  `wise-api-bun listening on http://localhost:${server.port} (db: ${config.dbPath})`,
);

/**
 * Graceful shutdown. Closing the database matters more than usual with SQLite:
 * it checkpoints the WAL, so an unclean exit leaves a -wal file that the next
 * start has to recover.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down`);
  await server.stop();
  // Stop the lock sweeper before closing the database so no timer fires against
  // a closed handle.
  lockManager.shutdown();
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
