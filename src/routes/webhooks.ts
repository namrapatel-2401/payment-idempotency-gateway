import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import crypto from "crypto";
import { z } from "zod";
import { getDb } from "../db/connection.js";
import { config } from "../config.js";
import { hashCanonicalJson } from "../utils/canonical-json.js";
import {
  applyProviderObservation,
  ProviderObservation,
} from "../services/provider-observation.service.js";

export const verifyWebhookSignature = (
  payload: string | Buffer,
  signature: string,
  secret: string,
): boolean => {
  if (!signature || !secret || signature.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(signature)) return false;
  try {
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
};

export const generateWebhookSignature = (
  payload: string | Buffer,
  secret: string,
): string => crypto.createHmac("sha256", secret).update(payload).digest("hex");

export const WebhookPayloadSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.enum(["payment.succeeded", "payment.failed"]),
  charge_id: z.string().min(1).optional(),
  idempotency_key: z.string().min(1).optional(),
  status: z.enum(["succeeded", "failed"]),
  failure_message: z.string().optional(),
  timestamp: z.string().datetime(),
  provider_revision: z.number().int().positive().default(1),
}).strict().refine(
  (payload) => Boolean(payload.charge_id || payload.idempotency_key),
  { message: "At least one provider correlation identifier is required" },
);

export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;
export const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

const toObservation = (payload: WebhookPayload, payloadHash: string): ProviderObservation => ({
  eventId: payload.event_id,
  chargeId: payload.charge_id,
  providerIdempotencyKey: payload.idempotency_key,
  status: payload.status,
  failureMessage: payload.failure_message,
  providerRevision: payload.provider_revision,
  providerEventAt: new Date(payload.timestamp),
  payloadHash,
  payload: payload as unknown as Record<string, unknown>,
  source: "webhook",
});

export const webhookRoutes = async (app: FastifyInstance) => {
  const webhookSecret = config.webhook.secret;

  app.post(
    "/webhooks/payment-provider",
    { config: { rawBody: true } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const signature = request.headers["x-webhook-signature"] as string;
      if (!signature) return reply.status(400).send({ error: "Missing webhook signature" });

      const rawPayload =
        typeof request.rawBody === "string"
          ? request.rawBody
          : Buffer.isBuffer(request.rawBody)
            ? request.rawBody.toString("utf8")
            : typeof request.body === "string"
              ? request.body
              : JSON.stringify(request.body);

      if (!verifyWebhookSignature(rawPayload, signature, webhookSecret)) {
        return reply.status(401).send({ error: "Invalid webhook signature" });
      }

      const parsed = WebhookPayloadSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid webhook payload schema" });
      const payload = parsed.data;
      const payloadHash = hashCanonicalJson(payload);
      if (Math.abs(Date.now() - new Date(payload.timestamp).getTime()) > WEBHOOK_TIMESTAMP_TOLERANCE_MS) {
        return reply.status(400).send({ error: "Webhook timestamp outside valid window (5 minutes tolerance)" });
      }

      try {
        const result = await getDb().transaction(async (trx) => {
          const existing = await trx("webhook_deliveries").where({ webhook_id: payload.event_id }).first();
          if (existing) {
            const storedHash = existing.payload_hash || hashCanonicalJson(existing.payload);
            if (!existing.payload_hash) {
              await trx("webhook_deliveries").where({ id: existing.id }).update({ payload_hash: storedHash });
            }
            if (storedHash !== payloadHash) {
              await trx("webhook_delivery_conflicts").insert({
                webhook_delivery_id: existing.id,
                payload_hash: payloadHash,
                payload: JSON.stringify(payload),
              }).onConflict(["webhook_delivery_id", "payload_hash"]).ignore();
              return { statusCode: 200, body: { received: true, conflict: true } };
            }
            return { statusCode: 200, body: { received: true, duplicate: true } };
          }

          const claim = await trx("webhook_deliveries").insert({
            webhook_id: payload.event_id,
            charge_id: payload.charge_id || null,
            event_type: payload.event_type,
            payload: JSON.stringify(payload),
            payload_hash: payloadHash,
            provider_revision: payload.provider_revision,
            provider_event_at: payload.timestamp,
          }).onConflict("webhook_id").ignore().returning("*");

          if (!claim.length) return { statusCode: 200, body: { received: true, duplicate: true } };

          const applied = await applyProviderObservation(trx, toObservation(payload, payloadHash));
          if (applied.kind === "missing") {
            await trx("orphaned_webhooks").insert({
              webhook_id: payload.event_id,
              charge_id: payload.charge_id || null,
              provider_idempotency_key: payload.idempotency_key,
              event_type: payload.event_type,
              payload: JSON.stringify(payload),
              payload_hash: payloadHash,
            });
            return { statusCode: 200, body: { received: true, orphaned: true } };
          }

          return {
            statusCode: 200,
            body:
              applied.kind === "correlation_conflict"
                ? { received: true, conflict: true, correlation_conflict: true }
                : applied.kind === "conflict"
                ? { received: true, conflict: true, ignored: true, terminal_state: applied.payment.status }
                : { received: true },
          };
        });
        return reply.status(result.statusCode).send(result.body);
      } catch (error: any) {
        app.log.error({ error, webhook_id: payload.event_id }, "Failed to process webhook");
        return reply.status(500).send({ error: "Internal error processing webhook" });
      }
    },
  );
};
