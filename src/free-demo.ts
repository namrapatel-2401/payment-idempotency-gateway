import { buildApp } from "./app.js";
import { config } from "./config.js";
import { closeDb } from "./db/connection.js";
import { logger } from "./utils/logger.js";

const providerPort = Number(process.env.PROVIDER_PORT || "3001");

const start = async (): Promise<void> => {
  const { buildProviderApp } = await import(
    new URL("../dist-provider/app.js", import.meta.url).href,
  );
  const provider = await buildProviderApp();
  const gateway = await buildApp();

  await provider.listen({ port: providerPort, host: "127.0.0.1" });
  await gateway.listen({ port: config.port, host: "0.0.0.0" });

  logger.info(
    `Free demo gateway listening on ${config.port}; provider is loopback-only on ${providerPort}`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down free demo gracefully...`);

    try {
      await gateway.close();
      await provider.close();
      await closeDb();
      process.exit(0);
    } catch (error) {
      logger.error(error, "Free demo shutdown failed");
      process.exit(1);
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
};

start().catch((error) => {
  logger.error(error, "Failed to start free demo");
  process.exit(1);
});
