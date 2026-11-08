import { describe, it, expect } from "vitest";
import {
  logPaymentLifecycle,
  logIdempotencyEvent,
  metrics,
  recordRecoveryClaim,
  recordRecoveryOutcome,
} from "../../src/observability/metrics.js";
import { buildApp } from "../../src/app.js";
describe("Phase 3E observability", () => {
  it("keeps labelled counters and gauges in a deterministic snapshot", () => {
    metrics.reset();
    recordRecoveryClaim("orphaned_webhook", 2);
    recordRecoveryOutcome("orphaned_webhook", "resolved");
    metrics.setGauge("recovery_in_flight", 1, { workflow: "orphaned_webhook" });

    expect(metrics.snapshot()).toMatchObject({
      counters: {
        "recovery_claims_total{workflow=orphaned_webhook}": 2,
        "recovery_outcomes_total{outcome=resolved,workflow=orphaned_webhook}": 1,
      },
      gauges: {
        "recovery_in_flight{workflow=orphaned_webhook}": 1,
      },
    });
  });

  it("exposes operational metrics without requiring a database connection", async () => {
    metrics.reset();
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      counters: { "http_requests_total{method=GET,route=/metrics}": 1 },
      gauges: {},
    });
    await app.close();
  });

  it("logs lifecycle with meta", () => {
    expect(() =>
      logPaymentLifecycle("PENDING", { id: "p1", reqId: "r1" }),
    ).not.toThrow();
  });
  it("logs idempotency", () => {
    expect(() => logIdempotencyEvent("k1", "COMPLETED", "r2")).not.toThrow();
  });
});
