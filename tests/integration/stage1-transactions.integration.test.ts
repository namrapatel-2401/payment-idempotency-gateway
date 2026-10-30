import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { FastifyInstance } from "fastify";
import { Knex } from "knex";
import { buildApp } from "../../src/app.js";
import { IdempotencyKeyRepository } from "../../src/db/repositories/idempotency-key.repository.js";
import { PaymentRepository } from "../../src/db/repositories/payment.repository.js";
import { PaymentProviderClient } from "../../src/services/provider.client.js";
import {
  cleanTestData,
  startTestDatabase,
  stopTestDatabase,
} from "../setup/test-db.js";

describe("Stage 1 - transaction propagation and claim fencing", () => {
  let app: FastifyInstance;
  let testDb: Knex;

  beforeAll(async () => {
    const dbSetup = await startTestDatabase();
    testDb = dbSetup.db;

    app = await buildApp();
    await app.ready();
  }, 180000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    await stopTestDatabase();
  });

  beforeEach(async () => {
    await cleanTestData(testDb);
    vi.restoreAllMocks();
  });

  const waitFor = async (
    predicate: () => Promise<boolean>,
    timeoutMs = 5000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for database state");
  };

  it("uses the supplied transaction handle and rolls back repository writes", async () => {
    const keyRepo = new IdempotencyKeyRepository();
    const paymentRepo = new PaymentRepository();
    const key = "stage1-transaction-propagation";

    await expect(
      testDb.transaction(async (trx) => {
        await keyRepo.create(
          {
            key,
            request_path: "/payments",
            request_hash: "a".repeat(64),
          },
          trx,
        );

        const insideTransaction = await keyRepo.findByKey(key, trx);
        expect(insideTransaction).not.toBeNull();

        const outsideTransaction = await testDb("idempotency_keys")
          .where({ key })
          .first();
        expect(outsideTransaction).toBeUndefined();

        const payment = await paymentRepo.create(
          {
            idempotency_key_id: insideTransaction!.id,
            provider_idempotency_key: "stage1-provider-key",
            amount: 100,
            currency: "USD",
            customer_email: "stage1@example.com",
          },
          trx,
        );
        expect(payment.id).toBeDefined();

        throw new Error("intentional transaction rollback");
      }),
    ).rejects.toThrow("intentional transaction rollback");

    expect(await testDb("idempotency_keys").where({ key }).first()).toBeUndefined();
    expect(
      await testDb("payments")
        .where({ provider_idempotency_key: "stage1-provider-key" })
        .first(),
    ).toBeUndefined();
  });

  it("atomically claims a new key and does not increment active duplicate claims", async () => {
    let releaseProvider!: () => void;
    const providerReleased = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const provider = vi
      .spyOn(PaymentProviderClient.prototype, "createCharge")
      .mockImplementation(async () => {
        await providerReleased;
        return {
          id: "ch_stage1_atomic",
          status: "succeeded",
          amount: 100,
          currency: "USD",
        };
      });

    const key = "stage1-atomic-claim";
    const payload = {
      amount: 100,
      currency: "USD",
      customer_email: "atomic@example.com",
    };

    const firstRequest = app.inject({
      method: "POST",
      url: "/payments",
      headers: { "idempotency-key": key },
      payload,
    });

    await waitFor(async () => {
      const record = await testDb("idempotency_keys").where({ key }).first();
      return record?.status === "processing";
    });

    const claimed = await testDb("idempotency_keys").where({ key }).first();
    expect(claimed.claim_generation).toBe(1);

    const duplicate = await app.inject({
      method: "POST",
      url: "/payments",
      headers: { "idempotency-key": key },
      payload,
    });
    expect(duplicate.statusCode).toBe(423);

    const afterDuplicate = await testDb("idempotency_keys").where({ key }).first();
    expect(afterDuplicate.claim_generation).toBe(1);
    expect(provider).toHaveBeenCalledTimes(1);

    releaseProvider();
    const firstResponse = await firstRequest;
    expect(firstResponse.statusCode).toBe(201);
  });

  it("rejects a different payload before starting a duplicate claim", async () => {
    const provider = vi
      .spyOn(PaymentProviderClient.prototype, "createCharge")
      .mockResolvedValue({
        id: "ch_stage1_payload",
        status: "succeeded",
        amount: 100,
        currency: "USD",
      });
    const key = "stage1-payload-conflict";

    const first = await app.inject({
      method: "POST",
      url: "/payments",
      headers: { "idempotency-key": key },
      payload: {
        amount: 100,
        currency: "USD",
        customer_email: "payload@example.com",
      },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/payments",
      headers: { "idempotency-key": key },
      payload: {
        amount: 200,
        currency: "USD",
        customer_email: "payload@example.com",
      },
    });
    expect(second.statusCode).toBe(409);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("fences an old provider worker after a stale claim is reclaimed", async () => {
    let releaseProvider!: () => void;
    const providerReleased = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    vi.spyOn(PaymentProviderClient.prototype, "createCharge").mockImplementation(
      async () => {
        await providerReleased;
        return {
          id: "ch_stage1_stale_worker",
          status: "succeeded",
          amount: 100,
          currency: "USD",
        };
      },
    );

    const key = "stage1-stale-worker";
    const firstRequest = app.inject({
      method: "POST",
      url: "/payments",
      headers: { "idempotency-key": key },
      payload: {
        amount: 100,
        currency: "USD",
        customer_email: "stale-worker@example.com",
      },
    });

    await waitFor(async () => {
      const record = await testDb("idempotency_keys").where({ key }).first();
      return record?.status === "processing";
    });

    await testDb("idempotency_keys").where({ key }).update({
      locked_at: new Date(Date.now() - 60000),
    });

    const reclaimResponse = await app.inject({
      method: "POST",
      url: "/payments",
      headers: { "idempotency-key": key },
      payload: {
        amount: 100,
        currency: "USD",
        customer_email: "stale-worker@example.com",
      },
    });
    expect(reclaimResponse.statusCode).toBe(500);

    const reclaimed = await testDb("idempotency_keys").where({ key }).first();
    expect(reclaimed.status).toBe("requires_reconciliation");
    expect(reclaimed.claim_generation).toBe(2);

    releaseProvider();
    const oldWorkerResponse = await firstRequest;
    expect(oldWorkerResponse.statusCode).toBe(500);

    const payment = await testDb("payments").where({ idempotency_key_id: reclaimed.id }).first();
    expect(payment.status).toBe("pending");
    expect(payment.provider_id).toBeNull();
  });

  it("preserves omitted provider fields while allowing explicit null clearing", async () => {
    const key = "stage1-partial-update";
    const [keyRecord] = await testDb("idempotency_keys").insert({
      key,
      request_path: "/payments",
      request_hash: "b".repeat(64),
      status: "processing",
    }).returning("*");
    const [payment] = await testDb("payments").insert({
      idempotency_key_id: keyRecord.id,
      provider_idempotency_key: "stage1-partial-provider-key",
      provider_id: "ch_existing_partial",
      provider_status: "succeeded",
      amount: 100,
      currency: "USD",
      customer_email: "partial@example.com",
      status: "pending",
    }).returning("*");

    const paymentRepo = new PaymentRepository();
    await paymentRepo.updateStatus(payment.id, "failed" as any, {
      failure_reason: "declined",
    }, testDb);
    let updated = await testDb("payments").where({ id: payment.id }).first();
    expect(updated.provider_id).toBe("ch_existing_partial");
    expect(updated.provider_status).toBe("succeeded");
    expect(updated.failure_reason).toBe("declined");

    await paymentRepo.updateStatus(payment.id, "failed" as any, {
      provider_id: null,
      provider_status: null,
      failure_reason: null,
    }, testDb);
    updated = await testDb("payments").where({ id: payment.id }).first();
    expect(updated.provider_id).toBeNull();
    expect(updated.provider_status).toBeNull();
    expect(updated.failure_reason).toBeNull();
  });

  it("enforces unique non-null provider charge IDs", async () => {
    const first = await testDb("idempotency_keys").insert({
      key: "stage1-provider-unique-a",
      request_path: "/payments",
      request_hash: "c".repeat(64),
      status: "processing",
    }).returning("*");
    const second = await testDb("idempotency_keys").insert({
      key: "stage1-provider-unique-b",
      request_path: "/payments",
      request_hash: "d".repeat(64),
      status: "processing",
    }).returning("*");

    const paymentData = (idempotencyKeyId: string) => ({
      idempotency_key_id: idempotencyKeyId,
      provider_idempotency_key: `unique-provider-key-${idempotencyKeyId}`,
      provider_id: "ch_unique_constraint",
      amount: 100,
      currency: "USD",
      customer_email: "unique@example.com",
      status: "pending",
    });
    await testDb("payments").insert(paymentData(first[0].id));
    await expect(testDb("payments").insert(paymentData(second[0].id))).rejects.toMatchObject({ code: "23505" });
  });
});
