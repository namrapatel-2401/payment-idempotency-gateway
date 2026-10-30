import { buildApp } from "./app.js";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { closeDb } from "./db/connection.js";

const start = async () => {
  let app;

  try {
    app = await buildApp();

    await app.listen({
      port: config.port,
      host: "0.0.0.0",
    });

    logger.info(
      `🚀 Payment Idempotency Gateway running on port ${config.port}`,
    );
    logger.info(`📊 Environment: ${config.nodeEnv}`);
    logger.info(
      `🔌 Database: ${config.db.host}:${config.db.port}/${config.db.name}`,
    );
  } catch (error) {
    logger.error(error, "❌ Failed to start server");
    process.exit(1);
  }

  // Graceful shutdown
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

  signals.forEach((signal) => {
    process.on(signal, async () => {
      logger.info(`Received ${signal}, shutting down gracefully...`);

      try {
        if (app) {
          await app.close();
        }
        await closeDb();
        logger.info("✅ Shutdown complete");
        process.exit(0);
      } catch (error) {
        logger.error(error, "❌ Error during shutdown");
        process.exit(1);
      }
    });
  });
};

start();
