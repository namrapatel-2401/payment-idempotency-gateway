import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestDatabase, stopTestDatabase, cleanTestData } from "../setup/test-db.js";
import { IdempotencyKeyRepository } from "../../src/db/repositories/idempotency-key.repository.js";
import { ProviderConflictRepository } from "../../src/db/repositories/provider-conflict.repository.js";
import { OrphanedWebhookRepository } from "../../src/db/repositories/orphaned-webhook.repository.js";
import type { Knex } from "knex";
import { up as applyRecoveryMigration, down as rollbackRecoveryMigration } from "../../src/db/migrations/006_recovery_claims.js";

describe("Phase 3A recovery claim primitives", () => {
  let db: Knex;
  const keys = new IdempotencyKeyRepository();
  const conflicts = new ProviderConflictRepository();
  const orphans = new OrphanedWebhookRepository();

  beforeAll(async () => {
    ({ db } = await startTestDatabase());
  });

  afterAll(async () => {
    await stopTestDatabase();
  });

  beforeEach(async () => {
    await cleanTestData(db);
  });

  const insertKey = async (suffix: string) => {
    const [key] = await db("idempotency_keys").insert({
      key: `recovery-${suffix}`,
      request_path: "/payments",
      request_hash: "hash",
      status: "requires_reconciliation",
      reconciliation_status: "pending",
      next_reconciliation_at: new Date(0),
    }).returning("*");
    await db("payments").insert({
      idempotency_key_id: key.id,
      provider_idempotency_key: `provider-${suffix}`,
      amount: 10,
      currency: "USD",
      customer_email: "test@example.com",
      status: "requires_reconciliation",
      metadata: {},
    });
    return key;
  };

  it("backfills existing records and exposes the recovery schema", async () => {
    await rollbackRecoveryMigration(db);
    const [key] = await db("idempotency_keys").insert({ key: "legacy-recovery", request_path: "/payments", request_hash: "hash", status: "requires_reconciliation" }).returning("id");
    const [resolved] = await db("orphaned_webhooks").insert({ webhook_id: "legacy-resolved", charge_id: "ch-resolved", event_type: "payment.updated", payload: {}, resolved: true }).returning("id");
    const [pending] = await db("orphaned_webhooks").insert({ webhook_id: "legacy-pending", charge_id: "ch-pending", event_type: "payment.updated", payload: {}, resolved: false }).returning("id");
    await applyRecoveryMigration(db);
    expect((await db("idempotency_keys").where({ id: key.id }).first()).reconciliation_status).toBe("pending");
    expect((await db("orphaned_webhooks").where({ id: resolved.id }).first()).recovery_status).toBe("resolved");
    expect((await db("orphaned_webhooks").where({ id: pending.id }).first()).recovery_status).toBe("pending");
  });

  it("claims distinct records concurrently and increments generations", async () => {
    await insertKey("one");
    await insertKey("two");
    const [a, b] = await Promise.all([
      db.transaction((trx) => keys.claimReconciliationBatch({ batchSize: 1 }, trx)),
      db.transaction((trx) => keys.claimReconciliationBatch({ batchSize: 1 }, trx)),
    ]);
    const claimed = [...a, ...b];
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map((row) => row.id)).size).toBe(2);
    expect(claimed.every((row) => row.claim_generation === 1 && row.reconciliation_claim_token)).toBe(true);
  });

  it("reclaims an expired lease and rejects the stale owner", async () => {
    const key = await insertKey("lease");
    const [first] = await db.transaction((trx) => keys.claimReconciliationBatch({}, trx));
    await db("idempotency_keys").where({ id: key.id }).update({
      reconciliation_locked_at: new Date(Date.now() - 120_000),
    });
    const [second] = await db.transaction((trx) => keys.claimReconciliationBatch({}, trx));
    expect(second.reconciliation_claim_token).not.toBe(first.reconciliation_claim_token);
    expect(second.claim_generation).toBe(2);
    expect(await keys.releaseReconciliation(key.id, first.reconciliation_claim_token, {}, db)).toBe(false);
    expect(await keys.releaseReconciliation(key.id, second.reconciliation_claim_token, { error: "retry" }, db)).toBe(true);
    expect((await db("idempotency_keys").where({ id: key.id }).first()).reconciliation_status).toBe("retrying");
  });

  it("rolls back an incomplete claim transaction", async () => {
    const key = await insertKey("rollback");
    await expect(db.transaction(async (trx) => {
      await keys.claimReconciliationBatch({}, trx);
      throw new Error("abort claim");
    })).rejects.toThrow("abort claim");
    const after = await db("idempotency_keys").where({ id: key.id }).first();
    expect(after.status).toBe("requires_reconciliation");
    expect(after.reconciliation_attempts).toBe(0);
    expect(after.claim_generation).toBe(0);
    expect(after.reconciliation_claim_token).toBeNull();
  });

  it("claims provider conflicts with a conflict token and fences stale release", async () => {
    const key = await insertKey("conflict");
    const [conflict] = await db("provider_conflicts").insert({
      payment_id: (await db("payments").where({ idempotency_key_id: key.id }).first()).id,
      idempotency_key_id: key.id,
      provider_event_id: "event-conflict",
      charge_id: "charge-conflict",
      provider_idempotency_key: "provider-conflict",
      payload_hash: "hash-conflict",
      incoming_status: "failed",
      payload: {},
      status: "pending",
      next_resolution_at: new Date(0),
    }).returning("*");
    const [claimed] = await db.transaction((trx) => conflicts.claimBatch({}, trx));
    expect(claimed.id).toBe(conflict.id);
    expect(await conflicts.release(conflict.id, "stale-token", {}, db)).toBe(false);
    expect(await conflicts.release(conflict.id, claimed.resolution_claim_token, { error: "temporary" }, db)).toBe(true);
  });

  it("claims orphaned webhooks and preserves the legacy resolved flag contract", async () => {
    const [orphan] = await db("orphaned_webhooks").insert({ webhook_id: "orphan-claim", charge_id: "charge-orphan", event_type: "payment.updated", payload: {}, resolved: false, recovery_status: "pending", next_recovery_at: new Date(0) }).returning("*");
    const [claimed] = await db.transaction((trx) => orphans.claimBatch({}, trx));
    expect(claimed.id).toBe(orphan.id);
    expect(await orphans.markResolved(orphan.id, claimed.recovery_claim_token, "applied", db)).toBe(true);
    const after = await db("orphaned_webhooks").where({ id: orphan.id }).first();
    expect(after.resolved).toBe(true);
    expect(after.recovery_status).toBe("resolved");
  });
});
