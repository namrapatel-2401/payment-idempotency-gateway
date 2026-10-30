import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import * as dbConnection from "../../src/db/connection.js";
import { PaymentStatus } from "../../src/models/payment-status.js";
import {
  verifyWebhookSignature,
  generateWebhookSignature,
  WebhookPayloadSchema,
  WEBHOOK_TIMESTAMP_TOLERANCE_MS,
} from "../../src/routes/webhooks.js";
import { config } from "../../src/config.js";

/**
 * Unit tests for webhook processing.
 *
 * Importers: None (test suite)
 * Affected API: POST /webhooks/payment-provider
 * Data schemas: WebhookPayload (event_id, event_type, charge_id, idempotency_key, status, failure_message, timestamp)
 * User instruction: "Implement all Critical and High-priority webhook issues identified in the review..."
 */
describe("Webhook Processing - Unit Tests", () => {
  const testSecret = "test-webhook-secret-key-12345678901234567890";

  describe("HMAC Signature Verification", () => {
    it("should generate and verify valid HMAC signature", () => {
      const payload = JSON.stringify({
        event_id: "evt_123",
        event_type: "payment.succeeded",
        charge_id: "ch_test123",
      });

      const signature = generateWebhookSignature(payload, testSecret);
      expect(typeof signature).toBe("string");
      expect(signature.length).toBe(64); // SHA-256 hex string

      const isValid = verifyWebhookSignature(payload, signature, testSecret);
      expect(isValid).toBe(true);
    });

    it("should reject signature when payload is modified (wire byte mismatch)", () => {
      const payload = JSON.stringify({
        event_id: "evt_123",
        event_type: "payment.succeeded",
        charge_id: "ch_test123",
      });
      const tamperedPayload = JSON.stringify({
        event_id: "evt_123",
        event_type: "payment.failed",
        charge_id: "ch_test123",
      });

      const signature = generateWebhookSignature(payload, testSecret);
      const isValid = verifyWebhookSignature(
        tamperedPayload,
        signature,
        testSecret,
      );

      expect(isValid).toBe(false);
    });

    it("should reject signature when secret is incorrect", () => {
      const payload = JSON.stringify({ event_type: "payment.succeeded" });
      const signature = generateWebhookSignature(payload, testSecret);

      const isValid = verifyWebhookSignature(
        payload,
        signature,
        "wrong-secret-that-is-at-least-32-chars-long",
      );
      expect(isValid).toBe(false);
    });

    it("should reject malformed, non-hex, or different-length signatures safely without throwing", () => {
      const payload = JSON.stringify({ event_type: "payment.succeeded" });

      expect(verifyWebhookSignature(payload, "short", testSecret)).toBe(false);
      expect(verifyWebhookSignature(payload, "", testSecret)).toBe(false);
      expect(
        verifyWebhookSignature(
          payload,
          "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
          testSecret,
        ),
      ).toBe(false);
      expect(
        verifyWebhookSignature(
          payload,
          "abcdef1234567890abcdef1234567890abcdef1234567890abcdef123456789012345",
          testSecret,
        ),
      ).toBe(false);
    });
  });

  describe("Webhook Payload Schema Validation", () => {
    it("should validate a valid payment.succeeded webhook payload with event_id", () => {
      const validPayload = {
        event_id: "evt_prov_001",
        event_type: "payment.succeeded",
        charge_id: "ch_987654",
        idempotency_key: "prov-key-100",
        status: "succeeded",
        timestamp: new Date().toISOString(),
      };

      const result = WebhookPayloadSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
    });

    it("should validate a valid payment.failed webhook payload with failure_message", () => {
      const validFailedPayload = {
        event_id: "evt_prov_002",
        event_type: "payment.failed",
        charge_id: "ch_987654",
        idempotency_key: "prov-key-100",
        status: "failed",
        failure_message: "Card was declined by issuing bank",
        timestamp: new Date().toISOString(),
      };

      const result = WebhookPayloadSchema.safeParse(validFailedPayload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.failure_message).toBe(
          "Card was declined by issuing bank",
        );
      }
    });

    it("should reject payload with missing required fields", () => {
      const invalidPayload = {
        event_type: "payment.succeeded",
        // missing charge_id, idempotency_key, status, timestamp
      };

      const result = WebhookPayloadSchema.safeParse(invalidPayload);
      expect(result.success).toBe(false);
    });

    it("should reject payload with invalid event_type or status", () => {
      const invalidPayload = {
        event_type: "payment.refunded", // not in allowed enum
        charge_id: "ch_123",
        idempotency_key: "prov-key-123",
        status: "refunded",
        timestamp: new Date().toISOString(),
      };

      const result = WebhookPayloadSchema.safeParse(invalidPayload);
      expect(result.success).toBe(false);
    });

    it("should reject payload with non-ISO timestamp", () => {
      const invalidPayload = {
        event_type: "payment.succeeded",
        charge_id: "ch_123",
        idempotency_key: "prov-key-123",
        status: "succeeded",
        timestamp: "invalid-date",
      };

      const result = WebhookPayloadSchema.safeParse(invalidPayload);
      expect(result.success).toBe(false);
    });
  });

  describe("Webhook HTTP Routes (POST /webhooks/payment-provider)", () => {
    let app: FastifyInstance;
    let mockPayments: Map<string, any>;
    let mockEvents: any[];
    let mockDeliveries: Map<string, any>;
    let mockOrphaned: any[];
    let mockKeys: Map<string, any>;
    let mockDeliveryConflicts: any[];

    beforeEach(async () => {
      mockPayments = new Map();
      mockEvents = [];
      mockDeliveries = new Map();
      mockOrphaned = [];
      mockKeys = new Map();
      mockDeliveryConflicts = [];

      // Create mock DB transaction & queries
      const mockTrx = (table: string) => {
        if (table === "webhook_deliveries") {
          return {
            where: (criteria: any) => ({
              first: async () => {
                if (criteria.webhook_id) {
                  return mockDeliveries.get(criteria.webhook_id);
                }
                return undefined;
              },
            }),
            insert: (data: any) => {
              const builder: any = {
                onConflict: () => builder,
                ignore: () => {
                  if (mockDeliveries.has(data.webhook_id)) return [];
                  const record = { id: `delivery-${data.webhook_id}`, ...data };
                  mockDeliveries.set(data.webhook_id, record);
                  builder._result = [record];
                  return builder;
                },
                returning: async () => {
                  if (builder._result) return builder._result;
                  if (mockDeliveries.has(data.webhook_id)) return [];
                  const record = { id: `delivery-${data.webhook_id}`, ...data };
                  mockDeliveries.set(data.webhook_id, record);
                  return [record];
                },
              };
              return builder;
            },
          };
        }
        if (table === "orphaned_webhooks") {
          return {
            insert: async (data: any) => {
              mockOrphaned.push(data);
              return [data];
            },
          };
        }
        if (table === "payments") {
          const builder: any = {
            forUpdate: () => builder,
            first: async () => {
              if (builder._criteria?.provider_id) {
                return Array.from(mockPayments.values()).find(
                  (p) => p.provider_id === builder._criteria.provider_id,
                );
              }
                if (builder._criteria?.provider_idempotency_key) {
                  return Array.from(mockPayments.values()).find(
                    (p) => p.provider_idempotency_key === builder._criteria.provider_idempotency_key,
                  );
                }
              if (builder._criteria?.id) {
                return mockPayments.get(builder._criteria.id);
              }
              return undefined;
            },
            update: async (updateData: any) => {
              const target = builder._criteria?.id
                ? mockPayments.get(builder._criteria.id)
                : null;
              if (target) {
                Object.assign(target, updateData);
              }
              return 1;
            },
            orWhere: (criteria: any) => {
              builder._orCriteria = criteria;
              const originalFirst = builder.first;
              builder.first = async () => {
                const direct = await originalFirst();
                if (direct) return direct;
                return Array.from(mockPayments.values()).find(
                  (p) => p.provider_id === builder._orCriteria.provider_id,
                );
              };
              return builder;
            },
          };
          return {
            where: (criteria: any) => {
              builder._criteria = criteria;
              return builder;
            },
          };
        }
        if (table === "idempotency_keys") {
          const builder: any = {
            forUpdate: () => builder,
            where: (criteria: any) => {
              builder._criteria = criteria;
              return builder;
            },
            first: async () => {
              const id = builder._criteria?.id;
              if (!mockKeys.has(id)) {
                mockKeys.set(id, {
                  id,
                  status: "processing",
                  response_code: null,
                  response_body: null,
                });
              }
              return mockKeys.get(id);
            },
            update: async (data: any) => {
              const key = mockKeys.get(builder._criteria?.id);
              if (key) Object.assign(key, data);
              return 1;
            },
          };
          return builder;
        }
        if (table === "provider_conflicts") {
          return {
            insert: (data: any) => ({
              onConflict: () => ({
                ignore: async () => {
                  mockDeliveryConflicts.push(data);
                  return [data];
                },
              }),
            }),
          };
        }
        if (table === "webhook_delivery_conflicts") {
          return {
            insert: (data: any) => ({
              onConflict: () => ({
                ignore: async () => {
                  mockDeliveryConflicts.push(data);
                  return [data];
                },
              }),
            }),
          };
        }
        if (table === "payment_events") {
          return {
            insert: async (eventData: any) => {
              mockEvents.push(eventData);
              return [eventData];
            },
          };
        }
        return {};
      };

      (mockTrx as any).fn = { now: () => new Date() };

      const mockKnex = {
        transaction: async (cb: (trx: any) => Promise<any>) => {
          return await cb(mockTrx);
        },
      };

      vi.spyOn(dbConnection, "getDb").mockReturnValue(mockKnex as any);

      app = await buildApp();
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
      vi.restoreAllMocks();
    });

    it("should reject webhook request when x-webhook-signature is missing", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/payment-provider",
        payload: {
          event_type: "payment.succeeded",
          charge_id: "ch_123",
          idempotency_key: "prov-key-001",
          status: "succeeded",
          timestamp: new Date().toISOString(),
        },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toContain("signature");
    });

    it("should reject webhook request with invalid signature", async () => {
      const payload = {
        event_type: "payment.succeeded",
        charge_id: "ch_123",
        idempotency_key: "prov-key-001",
        status: "succeeded",
        timestamp: new Date().toISOString(),
      };

      const response = await app.inject({
        method: "POST",
        url: "/webhooks/payment-provider",
        headers: {
          "x-webhook-signature":
            "0000000000000000000000000000000000000000000000000000000000000000",
        },
        payload,
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body).error).toContain("Invalid");
    });

    it("should reject webhook request with timestamp older than 5 minutes", async () => {
      const staleTimestamp = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      const payload = {
        event_id: "evt_stale_1",
        event_type: "payment.succeeded",
        charge_id: "ch_123",
        idempotency_key: "prov-key-001",
        status: "succeeded",
        timestamp: staleTimestamp,
      };

      const signature = generateWebhookSignature(
        JSON.stringify(payload),
        config.webhook.secret,
      );

      const response = await app.inject({
        method: "POST",
        url: "/webhooks/payment-provider",
        headers: {
          "x-webhook-signature": signature,
        },
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toContain("5 minutes tolerance");
    });

    it("should process valid webhook, update payment status to COMPLETED, record delivery and audit event", async () => {
      const paymentId = "pay-uuid-001";
      mockPayments.set(paymentId, {
        id: paymentId,
        provider_id: "ch_webhook_test_1",
        status: PaymentStatus.PROCESSING,
        amount: "100.00",
        currency: "USD",
      });

      const payload = {
        event_id: "evt_success_1",
        event_type: "payment.succeeded",
        charge_id: "ch_webhook_test_1",
        idempotency_key: "prov-key-123",
        status: "succeeded",
        timestamp: new Date().toISOString(),
      };

      const signature = generateWebhookSignature(
        JSON.stringify(payload),
        config.webhook.secret,
      );

      const response = await app.inject({
        method: "POST",
        url: "/webhooks/payment-provider",
        headers: {
          "x-webhook-signature": signature,
        },
        payload,
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).received).toBe(true);

      // Verify payment updated
      const updated = mockPayments.get(paymentId);
      expect(updated.status).toBe(PaymentStatus.COMPLETED);
      expect(updated.provider_status).toBe("succeeded");

      // Verify audit log event
      expect(mockEvents.length).toBe(1);
      expect(mockEvents[0].payment_id).toBe(paymentId);
      expect(mockEvents[0].event_type).toBe("webhook.payment.succeeded");

      // Verify delivery record stored in DB
      expect(mockDeliveries.has("evt_success_1")).toBe(true);
    });

    it("should process valid failed webhook and update payment status to FAILED with reason", async () => {
      const paymentId = "pay-uuid-002";
      mockPayments.set(paymentId, {
        id: paymentId,
        provider_id: "ch_webhook_fail_1",
        status: PaymentStatus.PROCESSING,
        amount: "50.00",
        currency: "USD",
      });

      const payload = {
        event_id: "evt_fail_1",
        event_type: "payment.failed",
        charge_id: "ch_webhook_fail_1",
        idempotency_key: "prov-key-123",
        status: "failed",
        failure_message: "Insufficient funds on credit card",
        timestamp: new Date().toISOString(),
      };

      const signature = generateWebhookSignature(
        JSON.stringify(payload),
        config.webhook.secret,
      );

      const response = await app.inject({
        method: "POST",
        url: "/webhooks/payment-provider",
        headers: {
          "x-webhook-signature": signature,
        },
        payload,
      });

      expect(response.statusCode).toBe(200);

      const updated = mockPayments.get(paymentId);
      expect(updated.status).toBe(PaymentStatus.FAILED);
      expect(updated.failure_reason).toBe("Insufficient funds on credit card");
      expect(mockEvents.length).toBe(1);
      expect(mockEvents[0].event_type).toBe("webhook.payment.failed");
      expect(mockDeliveries.has("evt_fail_1")).toBe(true);
    });

    it("should handle duplicate webhook delivery idempotently via database delivery check", async () => {
      const paymentId = "pay-uuid-003";
      mockPayments.set(paymentId, {
        id: paymentId,
        provider_id: "ch_webhook_dup_1",
        status: PaymentStatus.PROCESSING,
        amount: "75.00",
        currency: "USD",
      });

      const payload = {
        event_id: "evt_dup_1",
        event_type: "payment.succeeded",
        charge_id: "ch_webhook_dup_1",
        idempotency_key: "prov-key-123",
        status: "succeeded",
        timestamp: new Date().toISOString(),
      };

      const signature = generateWebhookSignature(
        JSON.stringify(payload),
        config.webhook.secret,
      );

      // First webhook delivery
      const response1 = await app.inject({
        method: "POST",
        url: "/webhooks/payment-provider",
        headers: {
          "x-webhook-signature": signature,
        },
        payload,
      });

      expect(response1.statusCode).toBe(200);
      expect(JSON.parse(response1.body).duplicate).toBeUndefined();
      expect(mockEvents.length).toBe(1);

      // Duplicate delivery
      const response2 = await app.inject({
        method: "POST",
        url: "/webhooks/payment-provider",
        headers: {
          "x-webhook-signature": signature,
        },
        payload,
      });

      expect(response2.statusCode).toBe(200);
      expect(JSON.parse(response2.body).duplicate).toBe(true);
      // Still only 1 audit event created
      expect(mockEvents.length).toBe(1);
    });

    it("should protect terminal state: do NOT overwrite COMPLETED payment and record conflict event", async () => {
      const paymentId = "pay-uuid-terminal-1";
      mockPayments.set(paymentId, {
        id: paymentId,
        provider_id: "ch_webhook_terminal_1",
        status: PaymentStatus.COMPLETED,
        amount: "100.00",
        currency: "USD",
      });

      // Incoming conflicting failure webhook
      const payload = {
        event_id: "evt_conflict_1",
        event_type: "payment.failed",
        charge_id: "ch_webhook_terminal_1",
        idempotency_key: "prov-key-123",
        status: "failed",
        failure_message: "Late dispute failure",
        timestamp: new Date().toISOString(),
      };

      const signature = generateWebhookSignature(
        JSON.stringify(payload),
        config.webhook.secret,
      );

      const response = await app.inject({
        method: "POST",
        url: "/webhooks/payment-provider",
        headers: {
          "x-webhook-signature": signature,
        },
        payload,
      });

      expect(response.statusCode).toBe(200);
      const resBody = JSON.parse(response.body);
      expect(resBody.received).toBe(true);
      expect(resBody.ignored).toBe(true);
      expect(resBody.terminal_state).toBe(PaymentStatus.COMPLETED);

      // Payment status was NOT modified
      expect(mockPayments.get(paymentId).status).toBe(PaymentStatus.COMPLETED);

      // Conflict audit event recorded
      expect(mockEvents.length).toBe(1);
      expect(mockEvents[0].event_type).toBe("webhook.conflict_ignored");
    });

    it("should record orphaned webhook when payment is unknown and return 200 OK", async () => {
      const payload = {
        event_id: "evt_unknown_1",
        event_type: "payment.succeeded",
        charge_id: "ch_unknown_payment_id",
        idempotency_key: "prov-key-unknown",
        status: "succeeded",
        timestamp: new Date().toISOString(),
      };

      const signature = generateWebhookSignature(
        JSON.stringify(payload),
        config.webhook.secret,
      );

      const response = await app.inject({
        method: "POST",
        url: "/webhooks/payment-provider",
        headers: {
          "x-webhook-signature": signature,
        },
        payload,
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).orphaned).toBe(true);
      expect(mockOrphaned.length).toBe(1);
      expect(mockOrphaned[0].charge_id).toBe("ch_unknown_payment_id");
      expect(mockDeliveries.has("evt_unknown_1")).toBe(true);
    });
  });
});
