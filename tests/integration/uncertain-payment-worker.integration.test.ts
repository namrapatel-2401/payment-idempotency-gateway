import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Knex } from "knex";
import { startTestDatabase, stopTestDatabase, cleanTestData } from "../setup/test-db.js";
import { UncertainPaymentRecoveryWorker } from "../../src/services/uncertain-payment-recovery.worker.js";
import { PaymentProviderClient } from "../../src/services/provider.client.js";
import { deriveProviderIdempotencyKey } from "../../src/utils/hash.js";

describe("Phase 3B uncertain payment recovery worker", () => {
  let db: Knex;

  beforeAll(async () => {
    ({ db } = await startTestDatabase());
  });

  afterAll(async () => {
    await stopTestDatabase();
  });

  beforeEach(async () => {
    await cleanTestData(db);
  });

  const insertUncertainPayment = async (suffix: string, attempts = 0) => {
    const gatewayKey = `worker-${suffix}`;
    const providerKey = deriveProviderIdempotencyKey(gatewayKey);
    const [key] = await db("idempotency_keys").insert({
      key: gatewayKey,
      request_path: "/payments",
      request_hash: `hash-${suffix}`,
      status: "requires_reconciliation",
      reconciliation_status: "pending",
      reconciliation_attempts: attempts,
      next_reconciliation_at: new Date(0),
    }).returning("*");
    const [payment] = await db("payments").insert({
      idempotency_key_id: key.id,
      provider_idempotency_key: providerKey,
      amount: 125,
      currency: "USD",
      customer_email: `${suffix}@example.com`,
      status: "requires_reconciliation",
      metadata: {},
    }).returning("*");
    return { key, payment, providerKey };
  };

  const workerWith = (client: Partial<PaymentProviderClient>, options = {}) =>
    new UncertainPaymentRecoveryWorker(client as PaymentProviderClient, {
      maxInFlight: 4,
      random: () => 0,
      ...options,
    });

  it("discovers and completes a payment after a successful provider lookup", async () => {
    const { key, payment, providerKey } = await insertUncertainPayment("success");
    const getCharge = vi.fn().mockResolvedValue({ id: "ch-worker-success", status: "succeeded", amount: 125, currency: "USD", provider_revision: 4 });
    const worker = workerWith({ getChargeByIdempotencyKey: getCharge });

    expect(await worker.runOnce()).toBe(1);
    expect(getCharge).toHaveBeenCalledWith(providerKey);
    const storedPayment = await db("payments").where({ id: payment.id }).first();
    const storedKey = await db("idempotency_keys").where({ id: key.id }).first();
    expect(storedPayment.status).toBe("completed");
    expect(storedKey.status).toBe("completed");
    expect(storedKey.reconciliation_status).toBe("resolved");
    expect(storedKey.response_body.status).toBe("completed");
  });

  it("persists a failed provider lookup as FAILED and never COMPLETED", async () => {
    const { key, payment } = await insertUncertainPayment("failed");
    const worker = workerWith({
      getChargeByIdempotencyKey: vi.fn().mockResolvedValue({ id: "ch-worker-failed", status: "failed", amount: 125, currency: "USD", failure_message: "declined" }),
    });

    await worker.runOnce();
    const storedPayment = await db("payments").where({ id: payment.id }).first();
    const storedKey = await db("idempotency_keys").where({ id: key.id }).first();
    expect(storedPayment.status).toBe("failed");
    expect(storedKey.status).toBe("failed");
    expect(storedKey.response_body.status).toBe("failed");
  });

  it("retries a missing provider record with the stable provider key", async () => {
    const { key, payment, providerKey } = await insertUncertainPayment("retry");
    const getCharge = vi.fn().mockResolvedValue(null);
    const createCharge = vi.fn().mockResolvedValue({ id: "ch-worker-retry", status: "succeeded", amount: 125, currency: "USD" });
    const worker = workerWith({ getChargeByIdempotencyKey: getCharge, createCharge });

    await worker.runOnce();
    expect(createCharge).toHaveBeenCalledWith(providerKey, expect.objectContaining({ amount: 125 }));
    const storedPayment = await db("payments").where({ id: payment.id }).first();
    expect(storedPayment.status).toBe("completed");
    expect((await db("idempotency_keys").where({ id: key.id }).first()).status).toBe("completed");
  });

  it("allows concurrent workers to claim distinct payments", async () => {
    const first = await insertUncertainPayment("concurrent-one");
    const second = await insertUncertainPayment("concurrent-two");
    const getCharge = vi.fn().mockImplementation(async (providerKey: string) => ({ id: `ch-${providerKey.slice(-8)}`, status: "succeeded", amount: 125, currency: "USD" }));
    const workerA = workerWith({ getChargeByIdempotencyKey: getCharge }, { maxInFlight: 1, batchSize: 1 });
    const workerB = workerWith({ getChargeByIdempotencyKey: getCharge }, { maxInFlight: 1, batchSize: 1 });

    const [a, b] = await Promise.all([workerA.runOnce(), workerB.runOnce()]);
    expect(a + b).toBe(2);
    expect((await db("payments").where({ id: first.payment.id }).first()).status).toBe("completed");
    expect((await db("payments").where({ id: second.payment.id }).first()).status).toBe("completed");
  });

  it("serializes overlapping polling cycles at the per-worker concurrency limit", async () => {
    const records = await Promise.all(
      Array.from({ length: 8 }, (_, index) => insertUncertainPayment(`overlap-${index}`)),
    );
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    let releaseFirstBatch!: () => void;
    let releaseSecondBatch!: () => void;
    const firstBatch = new Promise<void>((resolve) => { releaseFirstBatch = resolve; });
    const secondBatch = new Promise<void>((resolve) => { releaseSecondBatch = resolve; });
    let firstBatchReady!: () => void;
    let secondBatchReady!: () => void;
    const firstReady = new Promise<void>((resolve) => { firstBatchReady = resolve; });
    const secondReady = new Promise<void>((resolve) => { secondBatchReady = resolve; });

    const getCharge = vi.fn(async () => {
      const batch = calls < 4 ? firstBatch : secondBatch;
      calls += 1;
      const callNumber = calls;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (calls === 4) firstBatchReady();
      if (calls === 8) secondBatchReady();
      await batch;
      active -= 1;
      return { id: `ch-overlap-${callNumber}`, status: "succeeded" as const, amount: 125, currency: "USD" };
    });
    const worker = workerWith({ getChargeByIdempotencyKey: getCharge });

    const cycles = Promise.all([worker.runOnce(), worker.runOnce()]);
    await firstReady;
    expect(maximumActive).toBe(4);
    releaseFirstBatch();
    await secondReady;
    expect(maximumActive).toBe(4);
    releaseSecondBatch();
    expect(await cycles).toEqual([4, 4]);
    expect(active).toBe(0);
    expect((await db("payments").whereIn("id", records.map(({ payment }) => payment.id)).whereNot("status", "completed")).length).toBe(0);
  });

  it("reclaims an expired worker lease and fences the previous generation", async () => {
    const { key, payment } = await insertUncertainPayment("reclaim");
    await db("idempotency_keys").where({ id: key.id }).update({
      status: "processing",
      reconciliation_status: "processing",
      reconciliation_attempts: 1,
      claim_generation: 1,
      reconciliation_claim_token: "old-token",
      reconciliation_locked_at: new Date(Date.now() - 120_000),
      locked_at: new Date(Date.now() - 120_000),
    });
    const worker = workerWith({
      getChargeByIdempotencyKey: vi.fn().mockResolvedValue({ id: "ch-reclaimed", status: "succeeded", amount: 125, currency: "USD" }),
    });

    await worker.runOnce();
    const storedPayment = await db("payments").where({ id: payment.id }).first();
    const storedKey = await db("idempotency_keys").where({ id: key.id }).first();
    expect(storedPayment.status).toBe("completed");
    expect(storedKey.claim_generation).toBe(2);
    expect(storedKey.reconciliation_claim_token).toBeNull();
  });

  it("moves repeatedly failing work to manual review at the attempt limit", async () => {
    const { key } = await insertUncertainPayment("manual", 7);
    const worker = workerWith({
      getChargeByIdempotencyKey: vi.fn().mockRejectedValue(new Error("Provider request timeout")),
    });

    await worker.runOnce();
    const storedKey = await db("idempotency_keys").where({ id: key.id }).first();
    expect(storedKey.reconciliation_attempts).toBe(8);
    expect(storedKey.reconciliation_status).toBe("manual_review");
    expect(storedKey.reconciliation_manual_review_at).not.toBeNull();
    expect(storedKey.status).toBe("requires_reconciliation");
  });

  it("does not overwrite a terminal result established while lookup is in flight", async () => {
    const { key, payment, providerKey } = await insertUncertainPayment("race");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const worker = workerWith({
      getChargeByIdempotencyKey: vi.fn(async () => {
        await blocked;
        return { id: "ch-stale-worker", status: "succeeded", amount: 125, currency: "USD" };
      }),
    });
    const running = worker.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await db.transaction(async (trx) => {
      await trx("idempotency_keys").where({ id: key.id }).forUpdate().update({ status: "completed", response_code: 201, response_body: { status: "completed", provider_id: "ch-webhook-wins" }, reconciliation_claim_token: null, reconciliation_locked_at: null });
      await trx("payments").where({ id: payment.id }).forUpdate().update({ status: "completed", provider_id: "ch-webhook-wins" });
    });
    release();
    await running;
    const storedPayment = await db("payments").where({ id: payment.id }).first();
    expect(storedPayment.provider_id).toBe("ch-webhook-wins");
    expect(providerKey).toBeDefined();
  });
});
