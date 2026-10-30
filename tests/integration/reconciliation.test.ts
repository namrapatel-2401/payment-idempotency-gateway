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
import { config } from "../../src/config.js";
import { generateWebhookSignature } from "../../src/routes/webhooks.js";

describe("Reconciliation & Crash Recovery - Integration", () => {
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
    expect(updatedKey.response_body.status).toBe("completed");
  });

  it("persists a provider lookup failure as FAILED, never COMPLETED", async () => {
    const gatewayKey = "reconcile-provider-failed-004";
    const providerKey = deriveProviderIdempotencyKey(gatewayKey);
    const payload = {
      amount: 250,
      currency: "USD",
      customer_email: "provider-failed@example.com",
    };
    const requestHash = hashRequestBody(payload);
    const [keyRecord] = await testDb("idempotency_keys").insert({
      key: gatewayKey,
      request_path: "/payments",
      request_hash: requestHash,
      status: "requires_reconciliation",
    }).returning("*");
    const [paymentRecord] = await testDb("payments").insert({
      idempotency_key_id: keyRecord.id,
      provider_idempotency_key: providerKey,
      amount: payload.amount,
      currency: payload.currency,
      customer_email: payload.customer_email,
      status: "requires_reconciliation",
    }).returning("*");

    const lookup = vi.spyOn(PaymentProviderClient.prototype, "getChargeByIdempotencyKey")
      .mockResolvedValueOnce({
        id: "ch_provider_failed_004",
        status: "failed",
        amount: payload.amount,
        currency: payload.currency,
        failure_message: "Provider declined the payment",
      });
    const create = vi.spyOn(PaymentProviderClient.prototype, "createCharge");

    const response = await app.inject({
      method: "POST",
      url: "/payments",
      headers: { "idempotency-key": gatewayKey },
      payload,
    });

    expect(response.statusCode).toBe(502);
    expect(lookup).toHaveBeenCalledWith(providerKey);
    expect(create).not.toHaveBeenCalled();
    const payment = await testDb("payments").where({ id: paymentRecord.id }).first();
    const key = await testDb("idempotency_keys").where({ id: keyRecord.id }).first();
    expect(payment.status).toBe("failed");
    expect(payment.provider_id).toBe("ch_provider_failed_004");
    expect(key.status).toBe("failed");
    expect(key.response_code).toBe(502);
    expect(key.response_body.status).toBe("failed");
  });

  it("preserves reconciliation after an unknown provider lookup and retry failure", async () => {
    const gatewayKey = "reconcile-provider-unknown-005";
    const providerKey = deriveProviderIdempotencyKey(gatewayKey);
    const payload = {
      amount: 350,
      currency: "USD",
      customer_email: "provider-unknown@example.com",
    };
    const requestHash = hashRequestBody(payload);
    const [keyRecord] = await testDb("idempotency_keys").insert({
      key: gatewayKey,
      request_path: "/payments",
      request_hash: requestHash,
      status: "requires_reconciliation",
    }).returning("*");
    const [paymentRecord] = await testDb("payments").insert({
      idempotency_key_id: keyRecord.id,
      provider_idempotency_key: providerKey,
      amount: payload.amount,
      currency: payload.currency,
      customer_email: payload.customer_email,
      status: "requires_reconciliation",
    }).returning("*");

    vi.spyOn(PaymentProviderClient.prototype, "getChargeByIdempotencyKey").mockResolvedValueOnce(null);
    vi.spyOn(PaymentProviderClient.prototype, "createCharge").mockRejectedValueOnce(
      new Error("Provider request timeout"),
    );

    const response = await app.inject({
      method: "POST",
      url: "/payments",
      headers: { "idempotency-key": gatewayKey },
      payload,
    });

    expect(response.statusCode).toBe(500);
    const payment = await testDb("payments").where({ id: paymentRecord.id }).first();
    const key = await testDb("idempotency_keys").where({ id: keyRecord.id }).first();
    expect(payment.status).toBe("requires_reconciliation");
    expect(key.status).toBe("requires_reconciliation");
    expect(key.response_code).toBe(500);
    expect(key.response_body.status).toBe("requires_reconciliation");
  });

  it("fences an older reconciliation result after a webhook establishes a terminal result", async () => {
    const gatewayKey = "reconcile-webhook-race-006";
    const providerKey = deriveProviderIdempotencyKey(gatewayKey);
    const payload = {
      amount: 125,
      currency: "USD",
      customer_email: "reconcile-webhook-race@example.com",
    };
    const requestHash = hashRequestBody(payload);
    const [keyRecord] = await testDb("idempotency_keys").insert({
      key: gatewayKey,
      request_path: "/payments",
      request_hash: requestHash,
      status: "requires_reconciliation",
    }).returning("*");
    const [paymentRecord] = await testDb("payments").insert({
      idempotency_key_id: keyRecord.id,
      provider_idempotency_key: providerKey,
      amount: payload.amount,
      currency: payload.currency,
      customer_email: payload.customer_email,
      status: "requires_reconciliation",
    }).returning("*");

    let releaseLookup!: () => void;
    const lookupReleased = new Promise<void>((resolve) => { releaseLookup = resolve; });
    vi.spyOn(PaymentProviderClient.prototype, "getChargeByIdempotencyKey")
      .mockImplementationOnce(async () => {
        await lookupReleased;
        return {
          id: "ch_old_reconciliation_006",
          status: "succeeded",
          amount: payload.amount,
          currency: payload.currency,
        };
      });

    const reconciliationRequest = app.inject({
      method: "POST",
      url: "/payments",
      headers: { "idempotency-key": gatewayKey },
      payload,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const webhookPayload = {
      event_id: "evt_reconcile_webhook_race_006",
      event_type: "payment.succeeded",
      charge_id: "ch_webhook_wins_006",
      idempotency_key: providerKey,
      status: "succeeded",
      timestamp: new Date().toISOString(),
    };
    const rawWebhook = JSON.stringify(webhookPayload);
    const webhookResponse = await app.inject({
      method: "POST",
      url: "/webhooks/payment-provider",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": generateWebhookSignature(rawWebhook, config.webhook.secret),
      },
      payload: rawWebhook,
    });
    expect(webhookResponse.statusCode).toBe(200);

    releaseLookup();
    const oldResponse = await reconciliationRequest;
    expect(oldResponse.statusCode).toBe(500);

    const payment = await testDb("payments").where({ id: paymentRecord.id }).first();
    const key = await testDb("idempotency_keys").where({ id: keyRecord.id }).first();
    expect(payment.status).toBe("completed");
    expect(payment.provider_id).toBe("ch_webhook_wins_006");
    expect(key.status).toBe("completed");
    expect(key.response_code).toBe(201);
    expect(key.response_body.provider_id).toBe("ch_webhook_wins_006");
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

  it("uses one expired conflict lease for concurrent terminal-conflict retries", async () => {
    const gatewayKey = "conflict-lease-concurrency-004";
    const providerKey = deriveProviderIdempotencyKey(gatewayKey);
    const payload = {
      amount: 100,
      currency: "USD",
      customer_email: "conflict-lease@example.com",
    };
    const requestHash = hashRequestBody(payload);
    const responseBody = {
      id: "00000000-0000-4000-8000-000000000004",
      amount: 100,
      currency: "USD",
      customer_email: payload.customer_email,
      description: "conflict lease test",
      status: "completed",
      provider_id: "ch_conflict_lease",
      provider_status: "succeeded",
      failure_reason: null,
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const [keyRecord] = await testDb("idempotency_keys").insert({
      key: gatewayKey,
      request_path: "/payments",
      request_hash: requestHash,
      status: "completed",
      response_code: 201,
      response_body: responseBody,
    }).returning("*");
    const [paymentRecord] = await testDb("payments").insert({
      idempotency_key_id: keyRecord.id,
      provider_idempotency_key: providerKey,
      provider_id: "ch_conflict_lease",
      amount: 100,
      currency: "USD",
      customer_email: payload.customer_email,
      status: "completed",
    }).returning("*");
    const [conflict] = await testDb("provider_conflicts").insert({
      payment_id: paymentRecord.id,
      idempotency_key_id: keyRecord.id,
      provider_event_id: "evt_conflict_lease_004",
      charge_id: "ch_conflict_lease",
      provider_idempotency_key: providerKey,
      payload_hash: "e".repeat(64),
      incoming_status: "failed",
      current_status: "completed",
      payload: JSON.stringify({ event_id: "evt_conflict_lease_004" }),
      resolution_locked_at: new Date(Date.now() - 60000),
    }).returning("*");

    let releaseLookup!: () => void;
    const lookupReleased = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const lookup = vi.spyOn(PaymentProviderClient.prototype, "getChargeByIdempotencyKey")
      .mockImplementation(async () => {
        await lookupReleased;
        return { id: "ch_conflict_lease", status: "succeeded", amount: 100, currency: "USD" };
      });

    const requestsPromise = Promise.all([
      app.inject({ method: "POST", url: "/payments", headers: { "idempotency-key": gatewayKey }, payload }),
      app.inject({ method: "POST", url: "/payments", headers: { "idempotency-key": gatewayKey }, payload }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseLookup();
    const requests = await requestsPromise;
    expect(requests.map((response) => response.statusCode)).toEqual([201, 201]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect((await testDb("provider_conflicts").where({ id: conflict.id }).first()).status).toBe("resolved");
  });
});
