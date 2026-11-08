import knex, { Knex } from "knex";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

let db: Knex | null = null;

export const getDb = (): Knex => {
  if (!db) {
    db = knex({
      client: "pg",
      connection: config.db.url ?? {
        host: config.db.host,
        port: config.db.port,
        database: config.db.name,
        user: config.db.user,
        password: config.db.password,
      },
      pool: {
        min: config.db.poolMin,
        max: config.db.poolMax,
      },
      log: {
        warn(message) {
          logger.warn(message);
        },
        error(message) {
          logger.error(message);
        },
        deprecate(message) {
          logger.warn(message);
        },
        debug(message) {
          logger.debug(message);
        },
      },
    });
  }

  return db;
};

export const closeDb = async (): Promise<void> => {
  if (db) {
    await db.destroy();
    db = null;
    logger.info("Database connection closed");
  }
};

/**
 * Reset the cached db singleton so the next getDb() call creates a fresh connection.
 * Used in integration tests where each test file starts its own database container
 * and the singleton must reconnect to the new container's port.
 */
export const resetDb = async (): Promise<void> => {
  if (db) {
    try {
      await db.destroy();
    } catch {
      // Ignore errors from already-destroyed connections
    }
    db = null;
  }
};

export const checkDbHealth = async (): Promise<boolean> => {
  try {
    const result = await getDb().raw("SELECT 1 as health_check");
    return result.rows[0].health_check === 1;
  } catch (error) {
    logger.error({ error }, "Database health check failed");
    return false;
  }
};
