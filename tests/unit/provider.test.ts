import { describe, it, expect, beforeEach } from "vitest";
import { buildProviderApp } from "../../provider/app.js";
import { clearDatabase } from "../../provider/db.js";
import { providerConfig } from "../../provider/config.js";
import { FastifyInstance } from "fastify";

/**
 * Unit tests for the simulated payment provider service.
 *
 * Tests provider-side idempotency behavior:
 * - Same provider idempotency key returns cached charge (no duplicate)
 * - Different payload with same key returns HTTP 409
 * - Reconciliation lookup by idempotency key works correctly
 * - Runtime configuration updates are applied
 *
 * Importers: None (test suite)
 * Affected API: POST /provider/charge, GET /provider/charge/by-idempotency-key/:key, POST /provider/config
 * Data schemas: ProviderCharge (in-memory), ChargeRequest payload
 * User instruction: Phase 5 deliverable — verify provider-side idempotency guarantees
 */
describe("Simulated Payment Provider", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    clearDatabase();
    // Disable random failures/timeouts during tests
    providerConfig.failureRate = 0;
    providerConfig.timeoutRate = 0;
    providerConfig.minLatencyMs = 0;
    providerConfig.maxLatencyMs = 0;

    app = await buildProviderApp();
  });

  it("should require Idempotency-Key header on POST /provider/charge", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/provider/charge",
      payload: {
        amount: 100,
        currency: "USD",
        customer_email: "test@example.com",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toContain("Idempotency-Key");
  });

  it("should create a charge successfully with provider idempotency key", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/provider/charge",
      headers: {
        "idempotency-key": "prov-key-001",
      },
      payload: {
        amount: 100,
        currency: "USD",
        customer_email: "test@example.com",
        description: "Test charge",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.id).toMatch(/^ch_/);
    expect(body.status).toBe("succeeded");
    expect(body.amount).toBe(100);
    expect(body.currency).toBe("USD");
  });

  it("should return identical cached charge for duplicate request with same key (provider-side idempotency)", async () => {
    const payload = {
      amount: 250,
      currency: "USD",
      customer_email: "repeat@example.com",
    };

    // First request
    const response1 = await app.inject({
      method: "POST",
      url: "/provider/charge",
      headers: {
        "idempotency-key": "prov-key-002",
      },
      payload,
    });

    expect(response1.statusCode).toBe(200);
    const body1 = JSON.parse(response1.body);

    // Duplicate request
    const response2 = await app.inject({
      method: "POST",
      url: "/provider/charge",
      headers: {
        "idempotency-key": "prov-key-002",
      },
      payload,
    });

    expect(response2.statusCode).toBe(200);
    const body2 = JSON.parse(response2.body);

    expect(body2.id).toBe(body1.id);
    expect(body2.status).toBe(body1.status);
    expect(body2.amount).toBe(body1.amount);
  });

  it("should return 409 Conflict if provider idempotency key is reused with different payload", async () => {
    // First request
    await app.inject({
      method: "POST",
      url: "/provider/charge",
      headers: {
        "idempotency-key": "prov-key-003",
      },
      payload: {
        amount: 100,
        currency: "USD",
        customer_email: "first@example.com",
      },
    });

    // Reuse with different payload
    const response2 = await app.inject({
      method: "POST",
      url: "/provider/charge",
      headers: {
        "idempotency-key": "prov-key-003",
      },
      payload: {
        amount: 500, // Different amount
        currency: "USD",
        customer_email: "first@example.com",
      },
    });

    expect(response2.statusCode).toBe(409);
    expect(JSON.parse(response2.body).error).toContain("different payload");
  });

  it("should support reconciliation lookup by provider idempotency key", async () => {
    const key = "prov-reconcile-key-004";

    // Create charge
    const createRes = await app.inject({
      method: "POST",
      url: "/provider/charge",
      headers: {
        "idempotency-key": key,
      },
      payload: {
        amount: 300,
        currency: "USD",
        customer_email: "reconcile@example.com",
      },
    });

    const createdCharge = JSON.parse(createRes.body);

    // Reconcile lookup
    const lookupRes = await app.inject({
      method: "GET",
      url: `/provider/charge/by-idempotency-key/${encodeURIComponent(key)}`,
    });

    expect(lookupRes.statusCode).toBe(200);
    const reconciledCharge = JSON.parse(lookupRes.body);
    expect(reconciledCharge.id).toBe(createdCharge.id);
    expect(reconciledCharge.amount).toBe(300);
  });

  it("should return 404 for reconciliation lookup on unknown idempotency key", async () => {
    const lookupRes = await app.inject({
      method: "GET",
      url: "/provider/charge/by-idempotency-key/non-existent-key",
    });

    expect(lookupRes.statusCode).toBe(404);
  });

  it("should allow runtime configuration updates via POST /provider/config", async () => {
    const updateRes = await app.inject({
      method: "POST",
      url: "/provider/config",
      payload: {
        failureRate: 0.5,
        minLatencyMs: 50,
      },
    });

    expect(updateRes.statusCode).toBe(200);
    const body = JSON.parse(updateRes.body);
    expect(body.failureRate).toBe(0.5);
    expect(body.minLatencyMs).toBe(50);
    expect(providerConfig.failureRate).toBe(0.5);
  });
});
