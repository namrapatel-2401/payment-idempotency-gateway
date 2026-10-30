import { logger } from "../utils/logger.js";
export function logPaymentLifecycle(
  event: string,
  meta: Record<string, string>,
) {
  logger.info(
    { event, ...meta, reqId: meta.reqId || "none" },
    "payment-lifecycle",
  );
}
export function logIdempotencyEvent(
  key: string,
  status: string,
  reqId?: string,
) {
  logger.info(
    { key, status, reqId: reqId || "none", event: "idempotency" },
    "idempotency-event",
  );
}
export function logProviderEvent(
  providerId: string,
  outcome: string,
  reqId?: string,
) {
  logger.info(
    { providerId, outcome, reqId: reqId || "none", event: "provider" },
    "provider-event",
  );
}
export function logWebhookEvent(
  webhookId: string,
  status: string,
  reqId?: string,
) {
  logger.info(
    { webhookId, status, reqId: reqId || "none", event: "webhook" },
    "webhook-event",
  );
}
