import { closeDb } from "../db/connection.js";
import { OrphanedWebhookRecoveryWorker } from "../services/orphaned-webhook-recovery.worker.js";

const worker = new OrphanedWebhookRecoveryWorker();
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
