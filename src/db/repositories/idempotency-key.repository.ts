import type { Knex } from "knex";
import { getDb } from "../connection.js";
import { IdempotencyKey } from "../../models/payment.js";
import { IdempotencyKeyStatus } from "../../models/payment-status.js";
import crypto from "crypto";
import { RECOVERY_POLICY, recoveryDeadline, RecoveryClaimOptions } from "../recovery-policy.js";

export type DbExecutor = Knex | Knex.Transaction;

export class IdempotencyKeyRepository {
  async claimReconciliationBatch(
    options: RecoveryClaimOptions = {},
    db: DbExecutor = getDb(),
  ): Promise<Array<IdempotencyKey & { reconciliation_claim_token: string }>> {
    const now = options.now ?? new Date();
    const rows = await db("idempotency_keys")
      .where((q) => q
        .where((inner) => inner.where("status", IdempotencyKeyStatus.REQUIRES_RECONCILIATION).where((state) => state.whereNull("reconciliation_status").orWhereIn("reconciliation_status", ["pending", "retrying"])))
        .orWhere((inner) => inner.where("status", IdempotencyKeyStatus.PROCESSING).where("reconciliation_status", "processing")))
      .where((q) => q.whereNull("next_reconciliation_at").orWhere("next_reconciliation_at", "<=", now))
      .where("reconciliation_attempts", "<", RECOVERY_POLICY.maxAttempts)
      .where((q) => q.whereNull("reconciliation_locked_at").orWhere("reconciliation_locked_at", "<", recoveryDeadline(now, options.leaseMs ?? RECOVERY_POLICY.leaseMs)))
      .orderBy("created_at", "asc")
      .forUpdate()
      .skipLocked()
      .limit(options.batchSize ?? RECOVERY_POLICY.batchSize);

    const claimed: Array<IdempotencyKey & { reconciliation_claim_token: string }> = [];
    for (const row of rows) {
      const token = crypto.randomUUID();
      const generation = row.claim_generation + 1;
      const updated = await db("idempotency_keys").where({ id: row.id }).whereIn("status", [IdempotencyKeyStatus.REQUIRES_RECONCILIATION, IdempotencyKeyStatus.PROCESSING]).update({
        status: IdempotencyKeyStatus.PROCESSING,
        locked_at: db.fn.now(),
        claim_generation: generation,
        reconciliation_status: "processing",
        reconciliation_claim_token: token,
        reconciliation_locked_at: db.fn.now(),
        reconciliation_attempts: db.raw("reconciliation_attempts + 1"),
      });
      if (updated) {
        claimed.push({ ...row, status: IdempotencyKeyStatus.PROCESSING, locked_at: now, claim_generation: generation, reconciliation_status: "processing", reconciliation_claim_token: token, reconciliation_locked_at: now, reconciliation_attempts: row.reconciliation_attempts + 1 } as IdempotencyKey & { reconciliation_claim_token: string });
      }
    }
    return claimed;
  }

  async releaseReconciliation(
    id: string,
    token: string,
    update: { nextAt?: Date | null; error?: string | null; manualReview?: boolean } = {},
    db: DbExecutor = getDb(),
  ): Promise<boolean> {
    const values: Record<string, unknown> = {
      status: IdempotencyKeyStatus.REQUIRES_RECONCILIATION,
      locked_at: null,
      reconciliation_status: update.manualReview ? "manual_review" : "retrying",
      reconciliation_claim_token: null,
      reconciliation_locked_at: null,
      next_reconciliation_at: update.nextAt ?? null,
      reconciliation_last_error: update.error ?? null,
    };
    if (update.manualReview) values.reconciliation_manual_review_at = db.fn.now();
    return (await db("idempotency_keys").where({ id, reconciliation_claim_token: token, status: IdempotencyKeyStatus.PROCESSING }).update(values)) > 0;
  }

  async markReconciliationResolved(id: string, token: string, status: IdempotencyKeyStatus, db: DbExecutor = getDb()): Promise<boolean> {
    return (await db("idempotency_keys").where({ id, reconciliation_claim_token: token, status: IdempotencyKeyStatus.PROCESSING }).update({
      status,
      locked_at: null,
      reconciliation_status: "resolved",
      reconciliation_claim_token: null,
      reconciliation_locked_at: null,
      reconciliation_resolved_at: db.fn.now(),
      reconciliation_last_error: null,
    })) > 0;
  }
  /**
   * Insert a new idempotency key (INSERT ... ON CONFLICT DO NOTHING pattern)
   * Returns true if inserted, false if key already exists
   */
  async create(data: {
    key: string;
    request_path: string;
    request_hash: string;
  }, db: DbExecutor = getDb()): Promise<boolean> {
    const result = await db("idempotency_keys")
      .insert({
        key: data.key,
        request_path: data.request_path,
        request_hash: data.request_hash,
        status: IdempotencyKeyStatus.PENDING,
      })
      .onConflict("key")
      .ignore();

    return result.length > 0;
  }

  /**
   * Acquire exclusive lock on idempotency key row (SELECT ... FOR UPDATE)
   * This serializes concurrent requests with the same key
   */
  async findAndLock(
    key: string,
    db: DbExecutor = getDb(),
  ): Promise<IdempotencyKey | null> {
    const rows = await db("idempotency_keys")
      .where({ key })
      .forUpdate()
      .select("*");

    return rows[0] || null;
  }

  /**
   * Find idempotency key by key (without locking)
   */
  async findByKey(
    key: string,
    db: DbExecutor = getDb(),
  ): Promise<IdempotencyKey | null> {
    const row = await db("idempotency_keys").where({ key }).first();

    return row || null;
  }

  /**
   * Find an idempotency key by ID while holding its row lock.
   */
  async findByIdAndLock(
    id: string,
    db: DbExecutor = getDb(),
  ): Promise<IdempotencyKey | null> {
    const row = await db("idempotency_keys")
      .where({ id })
      .forUpdate()
      .first();

    return row || null;
  }

  /**
   * Update idempotency key status
   */
  async updateStatus(
    id: string,
    status: IdempotencyKeyStatus,
    lockedAt?: Date | null,
    claimGeneration?: number,
    db: DbExecutor = getDb(),
  ): Promise<void> {
    await db("idempotency_keys").where({ id }).update({
      status,
      locked_at: lockedAt,
      ...(claimGeneration === undefined
        ? {}
        : { claim_generation: claimGeneration }),
      updated_at: db.fn.now(),
    });
  }

  /**
   * Cache response in idempotency key
   */
  async cacheResponse(
    id: string,
    responseCode: number,
    responseBody: any,
    status: IdempotencyKeyStatus,
    db: DbExecutor = getDb(),
  ): Promise<void> {
    await db("idempotency_keys").where({ id }).update({
      response_code: responseCode,
      response_body: responseBody,
      status,
      locked_at: null,
      updated_at: db.fn.now(),
    });
  }
}
