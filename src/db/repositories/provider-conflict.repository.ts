import crypto from "crypto";
import { getDb } from "../connection.js";
import { RECOVERY_POLICY, recoveryDeadline, RecoveryClaimOptions } from "../recovery-policy.js";
import type { DbExecutor } from "./idempotency-key.repository.js";

export class ProviderConflictRepository {
  async claimBatch(
    options: RecoveryClaimOptions = {},
    db: DbExecutor = getDb(),
  ): Promise<any[]> {
    const now = options.now ?? new Date();
    const tokenized: any[] = [];
    const rows = await db("provider_conflicts")
      .whereIn("status", ["pending", "retrying", "resolving"])
      .where((q) => q.whereNull("next_resolution_at").orWhere("next_resolution_at", "<=", now))
      .where("resolution_attempts", "<", RECOVERY_POLICY.maxAttempts)
      .where((q) => q.whereNull("resolution_locked_at").orWhere("resolution_locked_at", "<", recoveryDeadline(now, options.leaseMs ?? RECOVERY_POLICY.leaseMs)))
      .orderBy("created_at", "asc")
      .forUpdate()
      .skipLocked()
      .limit(options.batchSize ?? RECOVERY_POLICY.batchSize);

    for (const row of rows) {
      const token = crypto.randomUUID();
      const updated = await db("provider_conflicts").where({ id: row.id }).whereIn("status", ["pending", "retrying", "resolving"]).update({
        status: "resolving",
        resolution_claim_token: token,
        resolution_locked_at: db.fn.now(),
        resolution_started_at: db.fn.now(),
        resolution_attempts: db.raw("resolution_attempts + 1"),
      });
      if (updated) tokenized.push({ ...row, status: "resolving", resolution_claim_token: token, resolution_attempts: row.resolution_attempts + 1 });
    }
    return tokenized;
  }

  async release(
    id: string,
    token: string,
    update: { nextAt?: Date | null; error?: string | null; manualReview?: boolean } = {},
    db: DbExecutor = getDb(),
  ): Promise<boolean> {
    const values: Record<string, unknown> = {
      status: update.manualReview ? "manual_review" : "retrying",
      resolution_claim_token: null,
      resolution_locked_at: null,
      next_resolution_at: update.nextAt ?? null,
      resolution_last_error: update.error ?? null,
    };
    if (update.manualReview) values.resolution_manual_review_at = db.fn.now();
    return (await db("provider_conflicts").where({ id, resolution_claim_token: token, status: "resolving" }).update(values)) > 0;
  }

  async markResolved(id: string, token: string, resolution: string, db: DbExecutor = getDb()): Promise<boolean> {
    return (await db("provider_conflicts").where({ id, resolution_claim_token: token, status: "resolving" }).update({
      status: "resolved",
      resolution,
      resolved_at: db.fn.now(),
      resolution_claim_token: null,
      resolution_locked_at: null,
      resolution_last_error: null,
    })) > 0;
  }
}
