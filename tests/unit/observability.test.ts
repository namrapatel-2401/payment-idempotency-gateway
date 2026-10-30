import { describe, it, expect } from "vitest";
import {
  logPaymentLifecycle,
  logIdempotencyEvent,
} from "../../src/observability/metrics.js";
describe("Phase 8 observability", () => {
  it("logs lifecycle with meta", () => {
    expect(() =>
      logPaymentLifecycle("PENDING", { id: "p1", reqId: "r1" }),
    ).not.toThrow();
  });
  it("logs idempotency", () => {
    expect(() => logIdempotencyEvent("k1", "COMPLETED", "r2")).not.toThrow();
  });
});
