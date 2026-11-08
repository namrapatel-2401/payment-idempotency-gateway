import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Knex } from "knex";
import { startTestDatabase, stopTestDatabase, cleanTestData } from "../setup/test-db.js";
import { ProviderConflictResolutionWorker } from "../../src/services/provider-conflict-resolution.worker.js";
import { PaymentProviderClient } from "../../src/services/provider.client.js";

describe("Phase 3C provider conflict resolution worker", () => {
  let db: Knex;

  beforeAll(async () => ({ db } = await startTestDatabase()));
  afterAll(async () => { await stopTestDatabase(); });
  beforeEach(async () => { await cleanTestData(db); });

  const insertConflict = async (suffix: string, status: "completed" | "failed" = "completed", attempts = 0) => {
    const [key] = await db("idempotency_keys").insert({
      key: `conflict-worker-${suffix}`, request_path: "/payments", request_hash: `hash-${suffix}`,
      status, response_code: status === "completed" ? 201 : 502,
      response_body: { status, provider_id: `ch-local-${suffix}` },
    }).returning("*");
    const [payment] = await db("payments").insert({
      idempotency_key_id: key.id, provider_idempotency_key: `provider-conflict-${suffix}`,
      provider_id: `ch-local-${suffix}`, amount: 100, currency: "USD",
      customer_email: `${suffix}@example.com`, status,
      provider_status: status === "completed" ? "succeeded" : "failed", metadata: {},
    }).returning("*");
    const [conflict] = await db("provider_conflicts").insert({
      payment_id: payment.id, idempotency_key_id: key.id, provider_event_id: `event-${suffix}`,
      charge_id: `ch-incoming-${suffix}`, provider_idempotency_key: `provider-conflict-${suffix}`,
      payload_hash: `hash-${suffix}`.padEnd(64, "x"),
      incoming_status: status === "completed" ? "failed" : "succeeded", incoming_revision: 3,
      current_status: status, status: "pending", payload: {}, resolution_attempts: attempts,
      next_resolution_at: new Date(0),
    }).returning("*");
    return { key, payment, conflict };
  };

  const workerWith = (client: Partial<PaymentProviderClient>, options = {}) =>
    new ProviderConflictResolutionWorker(client as PaymentProviderClient, { random: () => 0, ...options });

  it("discovers and resolves a provider-confirmed conflict", async () => {
    const { key, payment, conflict } = await insertConflict("confirmed");
    const worker = workerWith({ getChargeByIdempotencyKey: vi.fn().mockResolvedValue({ id: "ch-provider-confirmed", status: "succeeded", amount: 100, currency: "USD", provider_revision: 4 }) });
    expect(await worker.runOnce()).toBe(1);
    expect((await db("provider_conflicts").where({ id: conflict.id }).first()).resolution).toBe("PROVIDER_CONFIRMED");
    expect((await db("payments").where({ id: payment.id }).first()).status).toBe("completed");
    expect((await db("idempotency_keys").where({ id: key.id }).first()).response_body).toEqual(key.response_body);
  });

  it("preserves terminal payment and cached response for an opposite provider result", async () => {
    const { key, payment, conflict } = await insertConflict("opposite");
    const worker = workerWith({ getChargeByIdempotencyKey: vi.fn().mockResolvedValue({ id: "ch-provider-opposite", status: "failed", amount: 100, currency: "USD", provider_revision: 4 }) });
    await worker.runOnce();
    const storedPayment = await db("payments").where({ id: payment.id }).first();
    const storedKey = await db("idempotency_keys").where({ id: key.id }).first();
    expect(storedPayment.status).toBe("completed");
    expect(storedKey.response_body).toEqual(key.response_body);
    expect((await db("provider_conflicts").where({ id: conflict.id }).first()).resolution).toBe("TERMINAL_STATE_PRESERVED");
  });

  it("protects active leases and reclaims expired leases", async () => {
    const active = await insertConflict("active");
    const expired = await insertConflict("expired");
    await db("provider_conflicts").where({ id: active.conflict.id }).update({ status: "resolving", resolution_claim_token: "active", resolution_locked_at: new Date(), resolution_attempts: 1 });
    await db("provider_conflicts").where({ id: expired.conflict.id }).update({ status: "resolving", resolution_claim_token: "expired", resolution_locked_at: new Date(Date.now() - 120_000), resolution_attempts: 1 });
    const lookup = vi.fn().mockResolvedValue({ id: "ch-expired", status: "succeeded", amount: 100, currency: "USD", provider_revision: 4 });
    await workerWith({ getChargeByIdempotencyKey: lookup }, { batchSize: 2 }).runOnce();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect((await db("provider_conflicts").where({ id: active.conflict.id }).first()).status).toBe("resolving");
    expect((await db("provider_conflicts").where({ id: expired.conflict.id }).first()).status).toBe("resolved");
  });

  it("rejects a stale worker without adding a duplicate audit event", async () => {
    const { payment, conflict } = await insertConflict("stale");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const worker = workerWith({ getChargeByIdempotencyKey: vi.fn(async () => { await blocked; return { id: "ch-stale", status: "succeeded" as const, amount: 100, currency: "USD", provider_revision: 4 }; }) });
    const running = worker.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await db("provider_conflicts").where({ id: conflict.id }).update({ resolution_claim_token: "new-owner", resolution_locked_at: new Date(), status: "resolving" });
    release();
    await running;
    expect(await db("payment_events").where({ payment_id: payment.id, event_type: "webhook.conflict_ignored" })).toHaveLength(0);
  });

  it("retries timeouts and moves exhausted conflicts to manual review", async () => {
    const retry = await insertConflict("retry");
    const worker = workerWith({ getChargeByIdempotencyKey: vi.fn().mockRejectedValue(new Error("Provider request timeout")) });
    await worker.runOnce();
    expect((await db("provider_conflicts").where({ id: retry.conflict.id }).first()).status).toBe("retrying");
    const exhausted = await insertConflict("manual", "completed", 7);
    await worker.runOnce();
    expect((await db("provider_conflicts").where({ id: exhausted.conflict.id }).first()).status).toBe("manual_review");
  });

  it("retries a provider result older than known revisions", async () => {
    const { conflict } = await insertConflict("older");
    const worker = workerWith({ getChargeByIdempotencyKey: vi.fn().mockResolvedValue({ id: "ch-older", status: "succeeded", amount: 100, currency: "USD", provider_revision: 2 }) });
    await worker.runOnce();
    expect((await db("provider_conflicts").where({ id: conflict.id }).first()).status).toBe("retrying");
  });

  it("allows concurrent workers to claim different conflicts", async () => {
    const first = await insertConflict("concurrent-first");
    const second = await insertConflict("concurrent-second");
    const lookup = vi.fn().mockImplementation(async (key: string) => ({ id: `ch-${key}`, status: "succeeded" as const, amount: 100, currency: "USD", provider_revision: 4 }));
    const workerA = workerWith({ getChargeByIdempotencyKey: lookup }, { maxInFlight: 1, batchSize: 1 });
    const workerB = workerWith({ getChargeByIdempotencyKey: lookup }, { maxInFlight: 1, batchSize: 1 });
    const [a, b] = await Promise.all([workerA.runOnce(), workerB.runOnce()]);
    expect(a + b).toBe(2);
    expect((await db("provider_conflicts").where({ id: first.conflict.id }).first()).status).toBe("resolved");
    expect((await db("provider_conflicts").where({ id: second.conflict.id }).first()).status).toBe("resolved");
  });

  it("serializes overlapping polling cycles at four provider operations", async () => {
    const records = await Promise.all(Array.from({ length: 8 }, (_, i) => insertConflict(`overlap-${i}`)));
    let active = 0; let maximum = 0; let calls = 0;
    let releaseFirst!: () => void; let releaseSecond!: () => void;
    let firstReady!: () => void; let secondReady!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const firstWait = new Promise<void>((resolve) => { firstReady = resolve; });
    const secondWait = new Promise<void>((resolve) => { secondReady = resolve; });
    const lookup = vi.fn(async (key: string) => {
      calls += 1; const number = calls; const gate = number <= 4 ? firstGate : secondGate;
      active += 1; maximum = Math.max(maximum, active);
      if (number === 4) firstReady(); if (number === 8) secondReady();
      await gate; active -= 1;
      return { id: `ch-${key}-${number}`, status: "succeeded" as const, amount: 100, currency: "USD", provider_revision: 4 };
    });
    const worker = workerWith({ getChargeByIdempotencyKey: lookup });
    const cycles = Promise.all([worker.runOnce(), worker.runOnce()]);
    await firstWait; expect(maximum).toBe(4); releaseFirst();
    await secondWait; expect(maximum).toBe(4); releaseSecond();
    expect(await cycles).toEqual([4, 4]);
    expect(active).toBe(0);
    expect((await db("provider_conflicts").whereIn("id", records.map(({ conflict }) => conflict.id)).whereNot("status", "resolved")).length).toBe(0);
  });
});
