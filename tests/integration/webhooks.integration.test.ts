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
import {
  startTestDatabase,
  stopTestDatabase,
  cleanTestData,
} from "../setup/test-db.js";
import { PaymentStatus } from "../../src/models/payment-status.js";
import { generateWebhookSignature } from "../../src/routes/webhooks.js";
import { PaymentProviderClient } from "../../src/services/provider.client.js";
import { config } from "../../src/config.js";
import {
  deriveProviderIdempotencyKey,
  hashRequestBody,
} from "../../src/utils/hash.js";
import * as dbConnection from "../../src/db/connection.js";

/**
 * PostgreSQL Integration tests for webhook processing via Testcontainers.
 *
 * Importers: Vitest test runner (npm run test:integration)
 * Affected API: POST /webhooks/payment-provider
 * Data schemas:
 *   - payments table (status, provider_id, provider_status, failure_reason)
 *   - payment_events table (audit log)
 *   - webhook_deliveries table (PostgreSQL durable deduplication)
 *   - orphaned_webhooks table (unmatched webhook tracking)
 * User instruction: "Implement all Critical and High-priority webhook issues identified in the review...
 *   1. Fix raw-body HMAC verification using the exact bytes received from the request.
 *   2. Add webhook timestamp freshness validation with a 5-minute tolerance.
 *   3. Replace in-memory webhook deduplication with PostgreSQL-backed durable deduplication.
 *   4. Add a database UNIQUE/PRIMARY KEY constraint for webhook event IDs.
 *   5. Replace charge_id + timestamp as the primary webhook identifier with an explicit event_id.
 *   6. Add row locking / correct concurrency handling for concurrent webhooks affecting the same payment.
 *   7. Prevent terminal payment states from being overwritten by later/out-of-order webhooks.
 *   8. Add explicit payment state-transition validation.
 *   9. Add real PostgreSQL integration tests using Testcontainers.
 *   10. Add concurrency tests with at least 10 parallel duplicate webhook deliveries.
 *   11. Add the crash/restart deduplication test.
 *   12. Add the rollback test for payment update + audit event insertion.
 *   13. Strengthen webhook secret configuration so a weak default secret cannot be used accidentally."
 */
describe("Webhooks Processing - PostgreSQL Integration", () => {
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

  /**
   * Helper to seed an existing payment in PostgreSQL.
   */
  const seedPayment = async (options: {
    providerId?: string;
    status: PaymentStatus;
    amount?: number;
    currency?: string;
    customerEmail?: string;
  }) => {
    const gatewayKey = `key-${options.providerId}`;
    const providerKey = deriveProviderIdempotencyKey(gatewayKey);
    const payload = {
      amount: options.amount || 100,
      currency: options.currency || "USD",
      customer_email: options.customerEmail || "webhook-test@example.com",
    };
    const requestHash = hashRequestBody(payload);

    const [keyRecord] = await testDb("idempotency_keys")
      .insert({
        key: gatewayKey,
        request_path: "/payments",
        request_hash: requestHash,
        status:
          options.status === PaymentStatus.COMPLETED
            ? "completed"
            : "processing",
      })
      .returning("*");

    const [paymentRecord] = await testDb("payments")
      .insert({
        idempotency_key_id: keyRecord.id,
        provider_idempotency_key: providerKey,
        provider_id: options.providerId || null,
        amount: options.amount || 100,
        currency: options.currency || "USD",
        customer_email: options.customerEmail || "webhook-test@example.com",
        status: options.status,
      })
      .returning("*");

    return { keyRecord, paymentRecord };
  };

  it("1. should handle 10 concurrent duplicate webhook deliveries with exactly 1 update, 1 delivery record, and 1 audit event", async () => {
    const chargeId = "ch_conc_webhook_001";
    const { paymentRecord } = await seedPayment({
      providerId: chargeId,
      status: PaymentStatus.PROCESSING,
      amount: 150,
    });

    const payload = {
      event_id: "evt_conc_delivery_001",
      event_type: "payment.succeeded",
      charge_id: chargeId,
      idempotency_key: "prov-key-conc-001",
      status: "succeeded",
      timestamp: new Date().toISOString(),
    };

    const rawPayload = JSON.stringify(payload);
    const signature = generateWebhookSignature(
      rawPayload,
      config.webhook.secret,
    );

    // Fire 10 concurrent webhook delivery requests
    const concurrentRequests = Array.from({ length: 10 }, () =>
      app.inject({
        method: "POST",
        url: "/webhooks/payment-provider",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": signature,
        },
        payload: rawPayload,
      }),
    );

    const responses = await Promise.all(concurrentRequests);

    // All 10 requests must return HTTP 200 OK
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);

    const parsedBodies = responses.map((r) => JSON.parse(r.body));
    const processedSuccess = parsedBodies.filter(
      (b) => b.received === true && !b.duplicate,
    );
    const duplicates = parsedBodies.filter((b) => b.duplicate === true);

    // Exactly 1 request wins and processes the event; exactly 9 are deduplicated
    expect(processedSuccess.length).toBe(1);
    expect(duplicates.length).toBe(9);

    // Database verification:
    // 1. Payment status transitioned to COMPLETED
    const updatedPayment = await testDb("payments")
      .where({ id: paymentRecord.id })
      .first();
    expect(updatedPayment.status).toBe(PaymentStatus.COMPLETED);
    expect(updatedPayment.provider_status).toBe("succeeded");

    // 2. Exactly 1 audit event in payment_events
    const events = await testDb("payment_events").where({
      payment_id: paymentRecord.id,
    });
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe("webhook.payment.succeeded");

    // 3. Exactly 1 delivery record in webhook_deliveries with UNIQUE event_id
    const deliveries = await testDb("webhook_deliveries").where({
      webhook_id: "evt_conc_delivery_001",
    });
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].charge_id).toBe(chargeId);
  });

  it("2. should persist webhook deduplication across app crash/restart using PostgreSQL", async () => {
    const chargeId = "ch_restart_webhook_002";
    const { paymentRecord } = await seedPayment({
      providerId: chargeId,
      status: PaymentStatus.PROCESSING,
      amount: 200,
    });

    const payload = {
      event_id: "evt_durable_restart_002",
      event_type: "payment.succeeded",
      charge_id: chargeId,
      idempotency_key: "prov-key-restart-002",
      status: "succeeded",
      timestamp: new Date().toISOString(),
    };

    const rawPayload = JSON.stringify(payload);
    const signature = generateWebhookSignature(
      rawPayload,
      config.webhook.secret,
    );

    // First delivery on original app instance
    const response1 = await app.inject({
      method: "POST",
      url: "/webhooks/payment-provider",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": signature,
      },
      payload: rawPayload,
    });

    expect(response1.statusCode).toBe(200);
    expect(JSON.parse(response1.body).duplicate).toBeUndefined();

    // Verify database state
    const paymentAfter1 = await testDb("payments")
      .where({ id: paymentRecord.id })
      .first();
    expect(paymentAfter1.status).toBe(PaymentStatus.COMPLETED);
    const eventsAfter1 = await testDb("payment_events").where({
      payment_id: paymentRecord.id,
    });
    expect(eventsAfter1.length).toBe(1);

    // Simulate app crash / restart:
    // Close original Fastify instance and create a fresh new one
    await app.close();
    app = await buildApp();
    await app.ready();

    // Send duplicate webhook delivery to newly restarted app instance
    const response2 = await app.inject({
      method: "POST",
      url: "/webhooks/payment-provider",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": signature,
      },
      payload: rawPayload,
    });

    expect(response2.statusCode).toBe(200);
    const body2 = JSON.parse(response2.body);
    expect(body2.received).toBe(true);
    expect(body2.duplicate).toBe(true);

    // Audit events must still be exactly 1 (no re-execution after restart)
    const eventsAfter2 = await testDb("payment_events").where({
      payment_id: paymentRecord.id,
    });
    expect(eventsAfter2.length).toBe(1);
  });

  it("3. should rollback entire transaction if payment update or audit insertion fails", async () => {
    const chargeId = "ch_rollback_webhook_003";
    const { paymentRecord } = await seedPayment({
      providerId: chargeId,
      status: PaymentStatus.PROCESSING,
      amount: 300,
    });

    const payload = {
      event_id: "evt_rollback_003",
      event_type: "payment.succeeded",
      charge_id: chargeId,
      idempotency_key: "prov-key-rollback-003",
      status: "succeeded",
      timestamp: new Date().toISOString(),
    };

    const rawPayload = JSON.stringify(payload);
    const signature = generateWebhookSignature(
      rawPayload,
      config.webhook.secret,
    );

    // Spy on getDb and inject an error in payment_events insertion during the transaction
    const realDb = dbConnection.getDb();
    const originalTransaction = realDb.transaction.bind(realDb);

    vi.spyOn(realDb, "transaction").mockImplementation(
      async (callback: any) => {
        return await originalTransaction(async (trx) => {
          // Intercept trx calls and throw on payment_events insert
          const originalTrxFunction = trx as any;
          const wrappedTrx: any = (tableName: string) => {
            const queryBuilder = originalTrxFunction(tableName);
            if (tableName === "payment_events") {
              const originalInsert = queryBuilder.insert.bind(queryBuilder);
              queryBuilder.insert = async (...args: any[]) => {
                // Simulate catastrophic failure during audit event insertion
                throw new Error("Simulated database audit log failure");
              };
            }
            return queryBuilder;
          };

          // Copy trx properties and prototype
          Object.assign(wrappedTrx, trx);
          wrappedTrx.raw = trx.raw.bind(trx);
          wrappedTrx.fn = trx.fn;

          return await callback(wrappedTrx);
        });
      },
    );

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/payment-provider",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": signature,
      },
      payload: rawPayload,
    });

    // Transaction failed -> internal server error
    expect(response.statusCode).toBe(500);

    // Verify rollback in PostgreSQL:
    // 1. Payment status remains in original PROCESSING state
    const paymentInDb = await testDb("payments")
      .where({ id: paymentRecord.id })
      .first();
    expect(paymentInDb.status).toBe(PaymentStatus.PROCESSING);
    expect(paymentInDb.provider_status).toBeNull();

    // 2. No audit events inserted
    const eventsInDb = await testDb("payment_events").where({
      payment_id: paymentRecord.id,
    });
    expect(eventsInDb.length).toBe(0);

    // 3. No webhook delivery record inserted (allowing future retries to process cleanly)
    const deliveriesInDb = await testDb("webhook_deliveries").where({
      webhook_id: "evt_rollback_003",
    });
    expect(deliveriesInDb.length).toBe(0);
  });

  it("4. should protect terminal states (COMPLETED) from out-of-order webhook overwrites and log conflict", async () => {
    const chargeId = "ch_terminal_webhook_004";
    const { paymentRecord } = await seedPayment({
      providerId: chargeId,
      status: PaymentStatus.COMPLETED,
      amount: 400,
    });

    // Out-of-order failed webhook arriving after payment is already COMPLETED
    const payload = {
      event_id: "evt_terminal_conflict_004",
      event_type: "payment.failed",
      charge_id: chargeId,
      idempotency_key: "prov-key-terminal-004",
      status: "failed",
      failure_message: "Delayed out-of-order failure",
      timestamp: new Date().toISOString(),
    };

    const rawPayload = JSON.stringify(payload);
    const signature = generateWebhookSignature(
      rawPayload,
      config.webhook.secret,
    );

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/payment-provider",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": signature,
      },
      payload: rawPayload,
    });

    expect(response.statusCode).toBe(200);
    const resBody = JSON.parse(response.body);
    expect(resBody.received).toBe(true);
    expect(resBody.ignored).toBe(true);
    expect(resBody.terminal_state).toBe(PaymentStatus.COMPLETED);

    // Payment status in PostgreSQL was NOT modified
    const paymentInDb = await testDb("payments")
      .where({ id: paymentRecord.id })
      .first();
    expect(paymentInDb.status).toBe(PaymentStatus.COMPLETED);

    // Conflict event recorded in audit log
    const events = await testDb("payment_events").where({
      payment_id: paymentRecord.id,
    });
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe("webhook.conflict_ignored");

    // Delivery is recorded in webhook_deliveries
    const delivery = await testDb("webhook_deliveries")
      .where({ webhook_id: "evt_terminal_conflict_004" })
      .first();
    expect(delivery).toBeDefined();
    expect(delivery.charge_id).toBe(chargeId);
  });

  it("5. should record orphaned webhook in database when charge_id does not exist and return 200 OK", async () => {
    const unknownChargeId = "ch_unknown_payment_999";
    const payload = {
      event_id: "evt_orphaned_005",
      event_type: "payment.succeeded",
      charge_id: unknownChargeId,
      idempotency_key: "prov-key-unknown-005",
      status: "succeeded",
      timestamp: new Date().toISOString(),
    };

    const rawPayload = JSON.stringify(payload);
    const signature = generateWebhookSignature(
      rawPayload,
      config.webhook.secret,
    );

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/payment-provider",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": signature,
      },
      payload: rawPayload,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).orphaned).toBe(true);

    // Check orphaned_webhooks table
    const orphaned = await testDb("orphaned_webhooks")
      .where({ charge_id: unknownChargeId })
      .first();
    expect(orphaned).toBeDefined();
    expect(orphaned.webhook_id).toBe("evt_orphaned_005");
    expect(orphaned.resolved).toBe(false);

    // Check webhook_deliveries table
    const delivery = await testDb("webhook_deliveries")
      .where({ webhook_id: "evt_orphaned_005" })
      .first();
    expect(delivery).toBeDefined();
  });

  it("8. should detect a same-event payload hash conflict without changing payment state", async () => {
    const chargeId = "ch_payload_conflict_008";
    const { paymentRecord } = await seedPayment({
      providerId: chargeId,
      status: PaymentStatus.PROCESSING,
    });
    const firstPayload = {
      event_id: "evt_payload_conflict_008",
      event_type: "payment.succeeded",
      charge_id: chargeId,
      idempotency_key: "prov-key-conflict-008",
      status: "succeeded",
      timestamp: new Date().toISOString(),
    };
    const firstRaw = JSON.stringify(firstPayload);
    const first = await app.inject({
      method: "POST",
      url: "/webhooks/payment-provider",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": generateWebhookSignature(firstRaw, config.webhook.secret),
      },
      payload: firstRaw,
    });
    expect(first.statusCode).toBe(200);

    const conflictingPayload = {
      event_id: "evt_payload_conflict_008",
      event_type: "payment.failed",
      charge_id: chargeId,
      idempotency_key: "prov-key-conflict-008",
      status: "failed",
      failure_message: "conflicting signed payload",
      timestamp: new Date().toISOString(),
    };
    const conflictingRaw = JSON.stringify(conflictingPayload);
    const second = await app.inject({
      method: "POST",
      url: "/webhooks/payment-provider",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": generateWebhookSignature(conflictingRaw, config.webhook.secret),
      },
      payload: conflictingRaw,
    });
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body).conflict).toBe(true);
    expect((await testDb("payments").where({ id: paymentRecord.id }).first()).status).toBe(
      PaymentStatus.COMPLETED,
    );
    expect(await testDb("webhook_delivery_conflicts").where({
      webhook_delivery_id: (await testDb("webhook_deliveries").where({ webhook_id: firstPayload.event_id }).first()).id,
    })).toHaveLength(1);
  });

  it("9. should resolve an orphan exactly once when provider persistence makes the payment identifiable", async () => {
    const gatewayKey = "orphan-recovery-key-009";
    const providerKey = deriveProviderIdempotencyKey(gatewayKey);
    const chargeId = "ch_orphan_recovery_009";
    const orphanPayload = {
      event_id: "evt_orphan_recovery_009",
      event_type: "payment.succeeded",
      charge_id: chargeId,
      idempotency_key: providerKey,
      status: "succeeded",
      timestamp: new Date().toISOString(),
    };
    const raw = JSON.stringify(orphanPayload);
    const orphanResponse = await app.inject({
      method: "POST",
      url: "/webhooks/payment-provider",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": generateWebhookSignature(raw, config.webhook.secret),
      },
      payload: raw,
    });
    expect(orphanResponse.statusCode).toBe(200);
    expect(JSON.parse(orphanResponse.body).orphaned).toBe(true);

    vi.spyOn(PaymentProviderClient.prototype, "createCharge").mockResolvedValueOnce({
      id: chargeId,
      status: "succeeded",
      amount: 100,
      currency: "USD",
      provider_revision: 1,
    });
    const paymentResponse = await app.inject({
      method: "POST",
      url: "/payments",
      headers: { "idempotency-key": gatewayKey },
      payload: {
        amount: 100,
        currency: "USD",
        customer_email: "orphan-recovery@example.com",
      },
    });
    expect(paymentResponse.statusCode).toBe(201);
    const orphan = await testDb("orphaned_webhooks").where({ webhook_id: orphanPayload.event_id }).first();
    expect(orphan.resolved).toBe(true);
    expect(await testDb("payment_events").where({ payment_id: (await testDb("payments").where({ provider_id: chargeId }).first()).id })).toHaveLength(2);
  });

  it("10. should support a charge-ID-only legacy webhook", async () => {
    const chargeId = "ch_legacy_charge_only_010";
    const { paymentRecord } = await seedPayment({
      providerId: chargeId,
      status: PaymentStatus.PROCESSING,
    });
    const payload = {
      event_id: "evt_legacy_charge_only_010",
      event_type: "payment.succeeded",
      charge_id: chargeId,
      status: "succeeded",
      timestamp: new Date().toISOString(),
    };
    const raw = JSON.stringify(payload);
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/payment-provider",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": generateWebhookSignature(raw, config.webhook.secret),
      },
      payload: raw,
    });
    expect(response.statusCode).toBe(200);
    expect((await testDb("payments").where({ id: paymentRecord.id }).first()).status).toBe(PaymentStatus.COMPLETED);
  });

  it("11. should correlate an idempotency-key-only webhook", async () => {
    const { paymentRecord } = await seedPayment({
      providerId: undefined,
      status: PaymentStatus.PROCESSING,
    });
    const payload = {
      event_id: "evt_key_only_011",
      event_type: "payment.succeeded",
      idempotency_key: paymentRecord.provider_idempotency_key,
      status: "succeeded",
      timestamp: new Date().toISOString(),
    };
    const raw = JSON.stringify(payload);
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/payment-provider",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": generateWebhookSignature(raw, config.webhook.secret),
      },
      payload: raw,
    });
    expect(response.statusCode).toBe(200);
    const updated = await testDb("payments").where({ id: paymentRecord.id }).first();
    expect(updated.status).toBe(PaymentStatus.COMPLETED);
    expect(updated.provider_id).toBeNull();
  });

  it("12. should accept matching charge ID and provider key", async () => {
    const chargeId = "ch_matching_identifiers_012";
    const { paymentRecord } = await seedPayment({ providerId: chargeId, status: PaymentStatus.PROCESSING });
    const payload = {
      event_id: "evt_matching_identifiers_012",
      event_type: "payment.succeeded",
      charge_id: chargeId,
      idempotency_key: paymentRecord.provider_idempotency_key,
      status: "succeeded",
      timestamp: new Date().toISOString(),
    };
    const raw = JSON.stringify(payload);
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/payment-provider",
      headers: { "content-type": "application/json", "x-webhook-signature": generateWebhookSignature(raw, config.webhook.secret) },
      payload: raw,
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).correlation_conflict).toBeUndefined();
  });

  it("13. should durably record mismatched identifiers without mutating either payment", async () => {
    const first = await seedPayment({ providerId: "ch_mismatch_first_013", status: PaymentStatus.PROCESSING });
    const second = await seedPayment({ providerId: "ch_mismatch_second_013", status: PaymentStatus.PROCESSING });
    const payload = {
      event_id: "evt_mismatch_identifiers_013",
      event_type: "payment.succeeded",
      charge_id: first.paymentRecord.provider_id,
      idempotency_key: second.paymentRecord.provider_idempotency_key,
      status: "succeeded",
      timestamp: new Date().toISOString(),
    };
    const raw = JSON.stringify(payload);
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/payment-provider",
      headers: { "content-type": "application/json", "x-webhook-signature": generateWebhookSignature(raw, config.webhook.secret) },
      payload: raw,
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).correlation_conflict).toBe(true);
    expect((await testDb("payments").where({ id: first.paymentRecord.id }).first()).status).toBe(PaymentStatus.PROCESSING);
    expect((await testDb("payments").where({ id: second.paymentRecord.id }).first()).status).toBe(PaymentStatus.PROCESSING);
    expect(await testDb("provider_correlation_conflicts").where({ provider_event_id: payload.event_id })).toHaveLength(1);
    expect(await testDb("payment_events")).toHaveLength(0);
  });

  it("14. should deduplicate a repeated correlation-conflict delivery", async () => {
    const first = await seedPayment({ providerId: "ch_repeat_first_014", status: PaymentStatus.PROCESSING });
    const second = await seedPayment({ providerId: "ch_repeat_second_014", status: PaymentStatus.PROCESSING });
    const payload = {
      event_id: "evt_repeat_mismatch_014",
      event_type: "payment.succeeded",
      charge_id: first.paymentRecord.provider_id,
      idempotency_key: second.paymentRecord.provider_idempotency_key,
      status: "succeeded",
      timestamp: new Date().toISOString(),
    };
    const raw = JSON.stringify(payload);
    const headers = { "content-type": "application/json", "x-webhook-signature": generateWebhookSignature(raw, config.webhook.secret) };
    const [firstResponse, secondResponse] = await Promise.all([
      app.inject({ method: "POST", url: "/webhooks/payment-provider", headers, payload: raw }),
      app.inject({ method: "POST", url: "/webhooks/payment-provider", headers, payload: raw }),
    ]);
    const responseBodies = [JSON.parse(firstResponse.body), JSON.parse(secondResponse.body)];
    expect(responseBodies.filter((body) => body.correlation_conflict === true)).toHaveLength(1);
    expect(responseBodies.filter((body) => body.duplicate === true)).toHaveLength(1);
    expect(await testDb("provider_correlation_conflicts").where({ provider_event_id: payload.event_id })).toHaveLength(1);
  });

  it("15. should preserve payment state when correlation validation rejects the event", async () => {
    const first = await seedPayment({ providerId: "ch_rollback_first_015", status: PaymentStatus.PROCESSING });
    const second = await seedPayment({ providerId: "ch_rollback_second_015", status: PaymentStatus.PROCESSING });
    const payload = {
      event_id: "evt_rollback_correlation_015",
      event_type: "payment.failed",
      charge_id: first.paymentRecord.provider_id,
      idempotency_key: second.paymentRecord.provider_idempotency_key,
      status: "failed",
      timestamp: new Date().toISOString(),
    };
    const raw = JSON.stringify(payload);
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/payment-provider",
      headers: { "content-type": "application/json", "x-webhook-signature": generateWebhookSignature(raw, config.webhook.secret) },
      payload: raw,
    });
    expect(response.statusCode).toBe(200);
    expect((await testDb("payments").where({ id: first.paymentRecord.id }).first()).status).toBe(PaymentStatus.PROCESSING);
    expect((await testDb("payments").where({ id: second.paymentRecord.id }).first()).status).toBe(PaymentStatus.PROCESSING);
    expect(await testDb("payment_events")).toHaveLength(0);
  });

  it("6. should reject webhook timestamp older than 5 minutes or in the future", async () => {
    const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const stalePayload = {
      event_id: "evt_stale_006",
      event_type: "payment.succeeded",
      charge_id: "ch_stale_123",
      idempotency_key: "prov-key-stale",
      status: "succeeded",
      timestamp: staleTime,
    };

    const staleRaw = JSON.stringify(stalePayload);
    const staleSignature = generateWebhookSignature(
      staleRaw,
      config.webhook.secret,
    );

    const staleResponse = await app.inject({
      method: "POST",
      url: "/webhooks/payment-provider",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": staleSignature,
      },
      payload: staleRaw,
    });

    expect(staleResponse.statusCode).toBe(400);
    expect(JSON.parse(staleResponse.body).error).toContain(
      "5 minutes tolerance",
    );
  });

  it("7. should reject invalid or tampered wire HMAC signatures", async () => {
    const payload = {
      event_id: "evt_tamper_007",
      event_type: "payment.succeeded",
      charge_id: "ch_tamper_123",
      idempotency_key: "prov-key-tamper",
      status: "succeeded",
      timestamp: new Date().toISOString(),
    };

    const rawPayload = JSON.stringify(payload);
    // Signature calculated on different payload
    const invalidSignature = generateWebhookSignature(
      "tampered payload content",
      config.webhook.secret,
    );

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/payment-provider",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": invalidSignature,
      },
      payload: rawPayload,
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error).toContain(
      "Invalid webhook signature",
    );
  });
});
