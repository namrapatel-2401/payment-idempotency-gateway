import { logger } from "../utils/logger.js";

export type RecoveryWorkflow =
  | "uncertain_payment"
  | "provider_conflict"
  | "orphaned_webhook";

export type MetricLabels = Record<string, string>;

type MetricSnapshot = {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  generated_at: string;
};

const metricKey = (name: string, labels: MetricLabels): string => {
  const suffix = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return suffix ? `${name}{${suffix}}` : name;
};

class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  increment(name: string, value = 1, labels: MetricLabels = {}): void {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  setGauge(name: string, value: number, labels: MetricLabels = {}): void {
    this.gauges.set(metricKey(name, labels), value);
  }

  snapshot(): MetricSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      generated_at: new Date().toISOString(),
    };
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
  }
}

export const metrics = new MetricsRegistry();

export const recordRecoveryClaim = (
  workflow: RecoveryWorkflow,
  count: number,
): void => {
  if (count > 0) {
    metrics.increment("recovery_claims_total", count, { workflow });
  }
};

export const recordRecoveryOutcome = (
  workflow: RecoveryWorkflow,
  outcome: "resolved" | "retrying" | "manual_review" | "stale" | "failed",
): void => {
  metrics.increment("recovery_outcomes_total", 1, { workflow, outcome });
};

export const recordRecoveryPoll = (
  workflow: RecoveryWorkflow,
  outcome: "completed" | "failed",
): void => {
  metrics.increment("recovery_polls_total", 1, { workflow, outcome });
};

export const setRecoveryInFlight = (
  workflow: RecoveryWorkflow,
  count: number,
): void => {
  metrics.setGauge("recovery_in_flight", count, { workflow });
};

export const logOperationalEvent = (
  event: string,
  meta: Record<string, unknown> = {},
): void => {
  logger.info({ event, ...meta }, "operational-event");
};

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
