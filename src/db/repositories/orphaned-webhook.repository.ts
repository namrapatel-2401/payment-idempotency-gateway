import crypto from "crypto";
import { getDb } from "../connection.js";
import { RECOVERY_POLICY, recoveryDeadline, RecoveryClaimOptions } from "../recovery-policy.js";
import type { DbExecutor } from "./idempotency-key.repository.js";

export class OrphanedWebhookRepository {
  async claimBatch(options: RecoveryClaimOptions = {}, db: DbExecutor = getDb()): Promise<any[]> {
    const now = options.now ?? new Date();
    const rows = await db("orphaned_webhooks")
      .where("resolved", false)
      .where((q) => q.whereNull("recovery_status").orWhereIn("recovery_status", ["pending", "retrying", "processing"]))
      .where((q) => q.whereNull("next_recovery_at").orWhere("next_recovery_at", "<=", now))
      .where("recovery_attempts", "<", RECOVERY_POLICY.maxAttempts)
      .where((q) => q.whereNull("recovery_locked_at").orWhere("recovery_locked_at", "<", recoveryDeadline(now, options.leaseMs ?? RECOVERY_POLICY.leaseMs)))
      .orderBy("received_at", "asc")
      .forUpdate()
      .skipLocked()
      .limit(options.batchSize ?? RECOVERY_POLICY.batchSize);
    const claimed: any[] = [];
    for (const row of rows) {
      const token = crypto.randomUUID();
      const updated = await db("orphaned_webhooks").where({ id: row.id, resolved: false }).where((q) => q.whereNull("recovery_status").orWhereIn("recovery_status", ["pending", "retrying", "processing"])).update({
        recovery_status: "processing",
        recovery_claim_token: token,
        recovery_locked_at: db.fn.now(),
        recovery_attempts: db.raw("recovery_attempts + 1"),
      });
      if (updated) claimed.push({ ...row, recovery_status: "processing", recovery_claim_token: token, recovery_attempts: row.recovery_attempts + 1 });
    }
    return claimed;
  }

  async release(id: string, token: string, update: { nextAt?: Date | null; error?: string | null; manualReview?: boolean } = {}, db: DbExecutor = getDb()): Promise<boolean> {
    const values: Record<string, unknown> = {
      recovery_status: update.manualReview ? "manual_review" : "retrying",
      recovery_claim_token: null,
      recovery_locked_at: null,
      next_recovery_at: update.nextAt ?? null,
      recovery_last_error: update.error ?? null,
    };
    if (update.manualReview) values.recovery_manual_review_at = db.fn.now();
    return (await db("orphaned_webhooks").where({ id, recovery_claim_token: token, recovery_status: "processing" }).update(values)) > 0;
  }

  async markResolved(id: string, token: string, resolution: string, db: DbExecutor = getDb()): Promise<boolean> {
    return (await db("orphaned_webhooks").where({ id, recovery_claim_token: token, recovery_status: "processing", resolved: false }).update({
      resolved: true,
      resolved_at: db.fn.now(),
      recovery_status: "resolved",
      recovery_resolution: resolution,
      recovery_resolved_at: db.fn.now(),
      recovery_claim_token: null,
      recovery_locked_at: null,
      recovery_last_error: null,
    })) > 0;
  }
}
