import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { FastifyInstance } from "fastify";
import { Knex } from "knex";
import { buildApp } from "../../src/app.js";
import { PaymentProviderClient } from "../../src/services/provider.client.js";
import {
  startTestDatabase,
  stopTestDatabase,
  cleanTestData,
} from "../setup/test-db.js";
import {
  deriveProviderIdempotencyKey,
  hashRequestBody,
} from "../../src/utils/hash.js";

describe("Reconciliation & Crash Recovery - Integration", () => {
  let app: FastifyInstance;
  let testDb: Knex;

  beforeAll(async () => {
    const dbSetup = await startTestDatabase();
    testDb = dbSetup.db;

    process.env.DB_HOST = dbSetup.connectionConfig.host;
    process.env.DB_PORT = String(dbSetup.connectionConfig.port);
    process.env.DB_NAME = dbSetup.connectionConfig.database;
    process.env.DB_USER = dbSetup.connectionConfig.user;
    process.env.DB_PASSWORD = dbSetup.connectionConfig.password;

    app = await buildApp();
    await app.ready();
  }, 180000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase();
  });

  beforeEach(async () => {
    await cleanTestData(testDb);
    vi.restoreAllMocks();
  });

  it("CRITICAL: should reconcile when provider succeeded but gateway crashed before saving", async () => {
    const gatewayKey = "crash-test-key-001";
    const providerKey = deriveProviderIdempotencyKey(gatewayKey);
    const payload = {
      amount: 250,
      currency: "USD",
      customer_email: "crash-recovery@example.com",
      description: "Crash recovery test",
    };
    const requestHash = hashRequestBody(payload);

    // 1. Simulate state after gateway crash:
    // Idempotency key is in REQUIRES_RECONCILIATION status
    // Payment record exists in PENDING status
    const [keyRecord] = await testDb("idempotency_keys")
      .insert({
        key: gatewayKey,
        request_path: "/payments",
        request_hash: requestHash,
        status: "requires_reconciliation",
      })
      .returning("*");

    const [paymentRecord] = await testDb("payments")
      .insert({
        idempotency_key_id: keyRecord.id,
        provider_idempotency_key: providerKey,
        amount: payload.amount,
        currency: payload.currency,
        customer_email: payload.customer_email,
        description: payload.description,
        status: "pending",
      })
      .returning("*");

    // 2. Mock provider:
    // Provider already has the charge (because it succeeded before crash)
    const mockGetCharge = vi
      .spyOn(PaymentProviderClient.prototype, "getChargeByIdempotencyKey")
      .mockResolvedValueOnce({
        id: "ch_provider_already_created",
        status: "succeeded",
        amount: 250,
        currency: "USD",
      });

    // Provider createCharge should NEVER be called on reconciliation
    const mockCreateCharge = vi.spyOn(
      PaymentProviderClient.prototype,
      "createCharge",
    );

    // 3. Client retries the request
    const response = await app.inject({
      method: "POST",
      url: "/payments",
      headers: {
        "idempotency-key": gatewayKey,
      },
      payload,
    });

    // 4. Assertions:
    expect(response.statusCode).toBe(201);
    expect(mockGetCharge).toHaveBeenCalledWith(providerKey);
    expect(mockCreateCharge).not.toHaveBeenCalled(); // Crucial: NO duplicate charge!

    const body = JSON.parse(response.body);
    expect(body.status).toBe("completed");
    expect(body.provider_id).toBe("ch_provider_already_created");

    // 5. Database should be updated to COMPLETED
    const updatedPayment = await testDb("payments")
      .where({ id: paymentRecord.id })
      .first();
    expect(updatedPayment.status).toBe("completed");
    expect(updatedPayment.provider_id).toBe("ch_provider_already_created");

    const updatedKey = await testDb("idempotency_keys")
      .where({ id: keyRecord.id })
      .first();
    expect(updatedKey.status).toBe("completed");
    expect(updatedKey.response_code).toBe(201);
  });

  it("should retry charge when reconciliation finds no record at provider", async () => {
    const gatewayKey = "reconcile-retry-key-002";
    const providerKey = deriveProviderIdempotencyKey(gatewayKey);
    const payload = {
      amount: 350,
      currency: "USD",
      customer_email: "reconcile-retry@example.com",
    };
    const requestHash = hashRequestBody(payload);

    // Simulate ambiguous state
    const [keyRecord] = await testDb("idempotency_keys")
      .insert({
        key: gatewayKey,
        request_path: "/payments",
        request_hash: requestHash,
        status: "requires_reconciliation",
      })
      .returning("*");

    await testDb("payments").insert({
      idempotency_key_id: keyRecord.id,
      provider_idempotency_key: providerKey,
      amount: payload.amount,
      currency: payload.currency,
      customer_email: payload.customer_email,
      status: "requires_reconciliation",
    });

    // Provider returns null (never received or processed the charge)
    const mockGetCharge = vi
      .spyOn(PaymentProviderClient.prototype, "getChargeByIdempotencyKey")
      .mockResolvedValueOnce(null);

    // Provider creates the charge on retry
    const mockCreateCharge = vi
      .spyOn(PaymentProviderClient.prototype, "createCharge")
      .mockResolvedValueOnce({
        id: "ch_created_on_retry",
        status: "succeeded",
        amount: 350,
        currency: "USD",
      });

    // Client retries
    const response = await app.inject({
      method: "POST",
      url: "/payments",
      headers: {
        "idempotency-key": gatewayKey,
      },
      payload,
    });

    expect(response.statusCode).toBe(201);
    expect(mockGetCharge).toHaveBeenCalledWith(providerKey);
    expect(mockCreateCharge).toHaveBeenCalledTimes(1);

    const body = JSON.parse(response.body);
    expect(body.status).toBe("completed");
    expect(body.provider_id).toBe("ch_created_on_retry");
  });

  it("should detect stale locks (>30s) and mark as REQUIRES_RECONCILIATION", async () => {
    const gatewayKey = "stale-lock-key-003";
    const payload = {
      amount: 100,
      currency: "USD",
      customer_email: "stale@example.com",
    };
    const requestHash = hashRequestBody(payload);

    // Insert a key that has been PROCESSING for 60 seconds (stale lock)
    const sixtySecondsAgo = new Date(Date.now() - 60000);
    const [keyRecord] = await testDb("idempotency_keys")
      .insert({
        key: gatewayKey,
        request_path: "/payments",
        request_hash: requestHash,
        status: "processing",
        locked_at: sixtySecondsAgo,
      })
      .returning("*");

    // Client retries while lock is stale
    const response = await app.inject({
      method: "POST",
      url: "/payments",
      headers: {
        "idempotency-key": gatewayKey,
      },
      payload,
    });

    // Should return 500 indicating crash recovery needed
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).message).toContain("crashed");

    // Key status in database should transition to REQUIRES_RECONCILIATION
    const updatedKey = await testDb("idempotency_keys")
      .where({ id: keyRecord.id })
      .first();
    expect(updatedKey.status).toBe("requires_reconciliation");
  });
});
