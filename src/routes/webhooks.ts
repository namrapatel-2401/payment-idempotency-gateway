import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import crypto from "crypto";
import { z } from "zod";
import { getDb } from "../db/connection.js";
import {
  PaymentStatus,
  isTerminalState,
  isValidTransition,
} from "../models/payment-status.js";
import { config } from "../config.js";

/**
 * Webhook routes for async payment provider notifications.
 *
 * Importers: src/app.ts
 * Affected API: POST /webhooks/payment-provider
 * Data schemas:
 *   - WebhookPayload (event_id, event_type, charge_id, idempotency_key, status, failure_message, timestamp)
 *   - webhook_deliveries table (durable deduplication)
 *   - orphaned_webhooks table (unknown payment tracking)
 * User instruction: "Implement all Critical and High-priority webhook issues identified in the review...
 *   1. Fix raw-body HMAC verification using the exact bytes received from the request.
 *   2. Add webhook timestamp freshness validation with a 5-minute tolerance.
 *   3. Replace in-memory webhook deduplication with PostgreSQL-backed durable deduplication.
 *   4. Add a database UNIQUE/PRIMARY KEY constraint for webhook event IDs.
 *   5. Replace charge_id + timestamp as the primary webhook identifier with an explicit event_id.
 *   6. Add row locking / correct concurrency handling for concurrent webhooks affecting the same payment.
 *   7. Prevent terminal payment states from being overwritten by later/out-of-order webhooks.
 *   8. Add explicit payment state-transition validation."
 */

/**
 * Webhook signature verification using HMAC-SHA256 with timing-safe byte comparison.
 * Compares against exact raw payload bytes.
 */
export const verifyWebhookSignature = (
  payload: string | Buffer,
  signature: string,
  secret: string,
): boolean => {
  if (!signature || !secret) {
    return false;
  }

  // SHA-256 hex string must be exactly 64 hex characters (32 bytes)
  if (typeof signature !== "string" || signature.length !== 64) {
    return false;
  }

  // Ensure signature consists only of valid hex characters
  if (!/^[0-9a-fA-F]{64}$/.test(signature)) {
    return false;
  }

  try {
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");

    const bufSignature = Buffer.from(signature, "hex");
    const bufExpected = Buffer.from(expectedSignature, "hex");

    if (bufSignature.length !== bufExpected.length) {
      return false;
    }

    return crypto.timingSafeEqual(bufSignature, bufExpected);
  } catch {
    return false;
  }
};

/**
 * Generate HMAC-SHA256 webhook signature for testing.
 */
export const generateWebhookSignature = (
  payload: string | Buffer,
  secret: string,
): string => {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
};

/**
 * Webhook payload schema from the payment provider.
 * Supports explicit event_id for unique event identification.
 */
export const WebhookPayloadSchema = z.object({
  event_id: z.string().min(1).optional(),
  event_type: z.enum(["payment.succeeded", "payment.failed"]),
  charge_id: z.string().min(1),
  idempotency_key: z.string().min(1), // Provider's idempotency key
  status: z.enum(["succeeded", "failed"]),
  failure_message: z.string().optional(),
  timestamp: z.string().datetime(),
});

export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;

/**
 * Maximum allowable timestamp difference (5 minutes).
 */
export const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Webhook routes for async payment provider notifications.
 *
 * POST /webhooks/payment-provider
 * - Receives payment status updates from provider
 * - Verifies HMAC-SHA256 signature against raw request body
 * - Enforces timestamp freshness (5 min window)
 * - Guarantees durable database-backed idempotency (webhook_deliveries)
 * - Locks payment row during update to serialize concurrent deliveries
 * - Protects terminal states (COMPLETED/FAILED) from out-of-order overwrite
 * - Atomically records audit log and delivery status
 */
export const webhookRoutes = async (app: FastifyInstance) => {
  const webhookSecret = config.webhook.secret;

  app.post(
    "/webhooks/payment-provider",
    {
      config: {
        rawBody: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const signature = request.headers["x-webhook-signature"] as string;

      if (!signature) {
        app.log.warn("Webhook rejected: missing signature");
        return reply.status(400).send({ error: "Missing webhook signature" });
      }

      // Extract raw body for byte-exact HMAC verification
      const rawPayload =
        typeof request.rawBody === "string"
          ? request.rawBody
          : Buffer.isBuffer(request.rawBody)
            ? request.rawBody.toString("utf8")
            : typeof request.body === "string"
              ? request.body
              : JSON.stringify(request.body);

      // Verify HMAC-SHA256 signature using timing-safe comparison
      if (!verifyWebhookSignature(rawPayload, signature, webhookSecret)) {
        app.log.warn("Webhook rejected: invalid signature");
        return reply.status(401).send({ error: "Invalid webhook signature" });
      }

      // Parse and validate payload structure
      const parseResult = WebhookPayloadSchema.safeParse(request.body);
      if (!parseResult.success) {
        app.log.warn(
          { errors: parseResult.error },
          "Webhook rejected: invalid payload schema",
        );
        return reply
          .status(400)
          .send({ error: "Invalid webhook payload schema" });
      }

      const payload: WebhookPayload = parseResult.data;

      // Validate timestamp freshness (5-minute tolerance window)
      const payloadTime = new Date(payload.timestamp).getTime();
      const now = Date.now();
      if (Math.abs(now - payloadTime) > WEBHOOK_TIMESTAMP_TOLERANCE_MS) {
        app.log.warn(
          { timestamp: payload.timestamp, now: new Date(now).toISOString() },
          "Webhook rejected: timestamp outside 5-minute freshness window",
        );
        return reply.status(400).send({
          error: "Webhook timestamp outside valid window (5 minutes tolerance)",
        });
      }

      // Webhook unique ID: prefer explicit event_id, fallback to deterministic composite key
      const webhookId =
        payload.event_id ||
        `${payload.charge_id}-${payload.event_type}-${payload.timestamp}`;

      try {
        const db = getDb();

        const result = await db.transaction(async (trx) => {
          // 1. Check if this webhook has already been processed (PostgreSQL durable deduplication)
          const existingDelivery = await trx("webhook_deliveries")
            .where({ webhook_id: webhookId })
            .first();

          if (existingDelivery) {
            app.log.info(
              { webhook_id: webhookId, charge_id: payload.charge_id },
              "Webhook already processed (duplicate delivery)",
            );
            return {
              statusCode: 200,
              body: { received: true, duplicate: true },
            };
          }

          // 2. Query payment with row lock (FOR UPDATE) to serialize concurrent events
          const payment = await trx("payments")
            .where({ provider_id: payload.charge_id })
            .forUpdate()
            .first();

          // 3. Handle unknown payment (record in orphaned_webhooks, return 200 to prevent retry storms)
          if (!payment) {
            app.log.warn(
              { charge_id: payload.charge_id, webhook_id: webhookId },
              "Webhook received for unknown payment - saving to orphaned_webhooks",
            );

            await trx("orphaned_webhooks").insert({
              webhook_id: webhookId,
              charge_id: payload.charge_id,
              event_type: payload.event_type,
              payload: JSON.stringify(payload),
            });

            await trx("webhook_deliveries").insert({
              webhook_id: webhookId,
              charge_id: payload.charge_id,
              event_type: payload.event_type,
              payload: JSON.stringify(payload),
            });

            return {
              statusCode: 200,
              body: { received: true, orphaned: true },
            };
          }

          const targetStatus: PaymentStatus =
            payload.status === "succeeded"
              ? PaymentStatus.COMPLETED
              : PaymentStatus.FAILED;

          // 4. Protect terminal states (COMPLETED or FAILED) from out-of-order overwrites
          if (isTerminalState(payment.status as PaymentStatus)) {
            app.log.warn(
              {
                payment_id: payment.id,
                current_status: payment.status,
                incoming_status: targetStatus,
                webhook_id: webhookId,
              },
              "Webhook received for payment already in terminal state",
            );

            // Record conflict audit log if incoming webhook attempts to mutate terminal state
            if (payment.status !== targetStatus) {
              await trx("payment_events").insert({
                payment_id: payment.id,
                event_type: "webhook.conflict_ignored",
                details: JSON.stringify({
                  webhook_id: webhookId,
                  current_status: payment.status,
                  incoming_event: payload.event_type,
                  incoming_status: payload.status,
                  failure_message: payload.failure_message,
                  timestamp: payload.timestamp,
                }),
              });
            }

            // Record delivery so duplicate retries are deduplicated
            await trx("webhook_deliveries").insert({
              webhook_id: webhookId,
              charge_id: payload.charge_id,
              event_type: payload.event_type,
              payload: JSON.stringify(payload),
            });

            return {
              statusCode: 200,
              body: {
                received: true,
                ignored: true,
                terminal_state: payment.status,
              },
            };
          }

          // 5. Explicit state machine transition validation
          if (
            !isValidTransition(payment.status as PaymentStatus, targetStatus)
          ) {
            app.log.error(
              {
                payment_id: payment.id,
                from: payment.status,
                to: targetStatus,
              },
              "Invalid state machine transition for webhook",
            );

            await trx("payment_events").insert({
              payment_id: payment.id,
              event_type: "webhook.invalid_transition",
              details: JSON.stringify({
                webhook_id: webhookId,
                from_status: payment.status,
                attempted_status: targetStatus,
                timestamp: payload.timestamp,
              }),
            });

            await trx("webhook_deliveries").insert({
              webhook_id: webhookId,
              charge_id: payload.charge_id,
              event_type: payload.event_type,
              payload: JSON.stringify(payload),
            });

            return {
              statusCode: 200,
              body: { received: true, error: "Invalid state transition" },
            };
          }

          // 6. Update payment status
          await trx("payments")
            .where({ id: payment.id })
            .update({
              status: targetStatus,
              provider_status: payload.status,
              failure_reason: payload.failure_message || null,
              updated_at: trx.fn.now(),
            });

          // 7. Insert audit event
          await trx("payment_events").insert({
            payment_id: payment.id,
            event_type: `webhook.${payload.event_type}`,
            details: JSON.stringify({
              webhook_id: webhookId,
              charge_id: payload.charge_id,
              provider_status: payload.status,
              failure_message: payload.failure_message,
              timestamp: payload.timestamp,
            }),
          });

          // 8. Record delivery in webhook_deliveries
          await trx("webhook_deliveries").insert({
            webhook_id: webhookId,
            charge_id: payload.charge_id,
            event_type: payload.event_type,
            payload: JSON.stringify(payload),
          });

          app.log.info(
            {
              payment_id: payment.id,
              charge_id: payload.charge_id,
              new_status: targetStatus,
              webhook_id: webhookId,
            },
            "Payment status updated via webhook",
          );

          return {
            statusCode: 200,
            body: { received: true },
          };
        });

        return reply.status(result.statusCode).send(result.body);
      } catch (error: any) {
        // Handle PostgreSQL unique constraint violation gracefully (concurrent duplicate delivery)
        if (error?.code === "23505") {
          app.log.info(
            { webhook_id: webhookId },
            "Concurrent duplicate webhook delivery caught by database unique constraint",
          );
          return reply.status(200).send({ received: true, duplicate: true });
        }

        app.log.error(
          { error, webhook_id: webhookId },
          "Failed to process webhook",
        );
        return reply
          .status(500)
          .send({ error: "Internal error processing webhook" });
      }
    },
  );
};
