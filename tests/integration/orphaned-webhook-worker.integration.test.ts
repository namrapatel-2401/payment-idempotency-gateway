import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { startTestDatabase, stopTestDatabase, cleanTestData } from "../setup/test-db.js";
import { OrphanedWebhookRecoveryWorker } from "../../src/services/orphaned-webhook-recovery.worker.js";
import { deriveProviderIdempotencyKey } from "../../src/utils/hash.js";

describe("Phase 3D orphaned webhook recovery worker", () => {
  let db: Knex;

  beforeAll(async () => ({ db } = await startTestDatabase()));
  afterAll(async () => { await stopTestDatabase(); });
  beforeEach(async () => { await cleanTestData(db); });

  const insertPaymentAndOrphan = async (suffix: string, paymentStatus: "processing" | "completed" = "processing", orphan: Record<string, unknown> = {}) => {
    const gatewayKey = `orphan-worker-${suffix}`;
    const providerKey = deriveProviderIdempotencyKey(gatewayKey);
    const [key] = await db("idempotency_keys").insert({
      key: gatewayKey, request_path: "/payments", request_hash: `hash-${suffix}`,
      status: paymentStatus,
      response_code: paymentStatus === "completed" ? 201 : null,
      response_body: paymentStatus === "completed" ? { status: "completed", provider_id: `ch-local-${suffix}` } : null,
    }).returning("*");
    const [payment] = await db("payments").insert({
      idempotency_key_id: key.id, provider_idempotency_key: providerKey,
      provider_id: paymentStatus === "completed" ? `ch-local-${suffix}` : null,
      amount: 100, currency: "USD", customer_email: `${suffix}@example.com`,
      status: paymentStatus, metadata: {},
    }).returning("*");
    const payload = {
      event_id: `orphan-event-${suffix}`, event_type: "payment.succeeded",
      charge_id: `ch-webhook-${suffix}`, idempotency_key: providerKey,
      status: "succeeded", timestamp: new Date().toISOString(), provider_revision: 2,
      ...orphan,
    };
    const [orphanRow] = await db("orphaned_webhooks").insert({
      webhook_id: payload.event_id, charge_id: payload.charge_id,
      provider_idempotency_key: payload.idempotency_key, event_type: payload.event_type,
      payload: JSON.stringify(payload), resolved: false, recovery_status: "pending",
      next_recovery_at: new Date(0),
    }).returning("*");
    return { key, payment, orphan: orphanRow, providerKey, payload };
  };

  const runWorker = (options = {}) => new OrphanedWebhookRecoveryWorker({ random: () => 0, ...options });

  it("discovers and applies an orphan using its provider idempotency key", async () => {
    const { orphan, payment } = await insertPaymentAndOrphan("key-only", "processing", { charge_id: null });
    const worker = runWorker();
    expect(await worker.runOnce()).toBe(1);
    const stored = await db("orphaned_webhooks").where({ id: orphan.id }).first();
    expect(stored.recovery_status).toBe("resolved");
    expect((await db("payments").where({ id: payment.id }).first()).status).toBe("completed");
  });

  it("supports legacy charge-ID-only orphan recovery", async () => {
    const record = await insertPaymentAndOrphan("charge-only", "processing", { idempotency_key: null });
    await db("payments").where({ id: record.payment.id }).update({ provider_id: record.payload.charge_id });
    await runWorker().runOnce();
    expect((await db("orphaned_webhooks").where({ id: record.orphan.id }).first()).recovery_status).toBe("resolved");
    expect((await db("payments").where({ id: record.payment.id }).first()).status).toBe("completed");
  });

  it("records mismatched identifiers without mutating either payment", async () => {
    const first = await insertPaymentAndOrphan("mismatch-first");
    const second = await insertPaymentAndOrphan("mismatch-second");
    await db("payments").where({ id: second.payment.id }).update({ provider_id: second.payload.charge_id });
    await db("orphaned_webhooks").where({ id: first.orphan.id }).update({ charge_id: second.payload.charge_id, payload: JSON.stringify({ ...first.payload, charge_id: second.payload.charge_id }) });
    await runWorker().runOnce();
    expect((await db("payments").where({ id: first.payment.id }).first()).status).toBe("processing");
    expect((await db("payments").where({ id: second.payment.id }).first()).status).toBe("completed");
    expect((await db("provider_correlation_conflicts").where({ provider_event_id: first.orphan.webhook_id })).length).toBe(1);
    expect((await db("orphaned_webhooks").where({ id: first.orphan.id }).first()).recovery_status).toBe("retrying");
  });

  it("reclaims an expired lease and rejects a stale owner", async () => {
    const record = await insertPaymentAndOrphan("lease");
    await db("orphaned_webhooks").where({ id: record.orphan.id }).update({ recovery_status: "processing", recovery_claim_token: "old-owner", recovery_locked_at: new Date(Date.now() - 120_000), recovery_attempts: 1 });
    await runWorker().runOnce();
    const stored = await db("orphaned_webhooks").where({ id: record.orphan.id }).first();
    expect(stored.recovery_status).toBe("resolved");
    expect(stored.recovery_attempts).toBe(2);
    expect(stored.recovery_claim_token).toBeNull();
  });

  it("preserves terminal payment and cached response while recording a terminal conflict", async () => {
    const record = await insertPaymentAndOrphan("terminal", "completed", { charge_id: "ch-local-terminal", status: "failed", event_type: "payment.failed", provider_revision: 4 });
    const original = record.key.response_body;
    await runWorker().runOnce();
    const storedKey = await db("idempotency_keys").where({ id: record.key.id }).first();
    const storedOrphan = await db("orphaned_webhooks").where({ id: record.orphan.id }).first();
    expect(storedKey.response_body).toEqual(original);
    expect((await db("payments").where({ id: record.payment.id }).first()).status).toBe("completed");
    expect(storedOrphan.recovery_resolution).toBe("terminal_conflict_preserved");
    expect((await db("provider_conflicts").where({ provider_event_id: record.orphan.webhook_id })).length).toBe(1);
  });

  it("does not duplicate payment events when recovery is retried after resolution", async () => {
    const record = await insertPaymentAndOrphan("duplicate");
    const worker = runWorker();
    await worker.runOnce();
    await worker.runOnce();
    expect(await db("payment_events").where({ payment_id: record.payment.id }).whereRaw("details->>'event_id' = ?", [record.orphan.webhook_id])).toHaveLength(1);
  });

  it("retries unidentifiable orphans and moves exhausted work to manual review", async () => {
    const record = await insertPaymentAndOrphan("unknown");
    await db("orphaned_webhooks").where({ id: record.orphan.id }).update({ charge_id: null, provider_idempotency_key: null, payload: JSON.stringify({ event_id: record.orphan.webhook_id, status: "succeeded", timestamp: new Date().toISOString() }) });
    await runWorker().runOnce();
    expect((await db("orphaned_webhooks").where({ id: record.orphan.id }).first()).recovery_status).toBe("retrying");
    await db("orphaned_webhooks").where({ id: record.orphan.id }).update({ recovery_attempts: 7, next_recovery_at: new Date(0) });
    await runWorker().runOnce();
    expect((await db("orphaned_webhooks").where({ id: record.orphan.id }).first()).recovery_status).toBe("manual_review");
  });

  it("handles two overlapping cycles without stranding claimed orphans", async () => {
    const records = await Promise.all(Array.from({ length: 8 }, (_, i) => insertPaymentAndOrphan(`overlap-${i}`)));
    const worker = runWorker();
    const [first, second] = await Promise.all([worker.runOnce(), worker.runOnce()]);
    expect([first, second]).toEqual([4, 4]);
    expect((await db("orphaned_webhooks").whereIn("id", records.map(({ orphan }) => orphan.id)).whereNot("recovery_status", "resolved")).length).toBe(0);
  });
});
