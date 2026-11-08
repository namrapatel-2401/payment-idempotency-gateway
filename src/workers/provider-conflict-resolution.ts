import { closeDb } from "../db/connection.js";
import { ProviderConflictResolutionWorker } from "../services/provider-conflict-resolution.worker.js";

const worker = new ProviderConflictResolutionWorker();
let shuttingDown = false;

const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  await worker.stop();
  await closeDb();
};

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

worker.start();
