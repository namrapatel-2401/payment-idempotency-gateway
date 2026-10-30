import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { FastifyInstance } from "fastify";
import { Knex } from "knex";
import { StartedTestContainer } from "testcontainers";
import { buildApp } from "../../src/app.js";
import { PaymentProviderClient } from "../../src/services/provider.client.js";
import {
  startTestDatabase,
  stopTestDatabase,
  cleanTestData,
} from "../setup/test-db.js";

describe("POST /payments - Integration", () => {
  let app: FastifyInstance;
  let container: StartedTestContainer;
  let testDb: Knex;

  beforeAll(async () => {
    // Start test database with Testcontainers
    const dbSetup = await startTestDatabase();
    container = dbSetup.container;
    testDb = dbSetup.db;

    // Override environment variables for the app
    process.env.DB_HOST = dbSetup.connectionConfig.host;
    process.env.DB_PORT = String(dbSetup.connectionConfig.port);
    process.env.DB_NAME = dbSetup.connectionConfig.database;
    process.env.DB_USER = dbSetup.connectionConfig.user;
    process.env.DB_PASSWORD = dbSetup.connectionConfig.password;

    app = await buildApp();
    await app.ready();

    // Clean up test data
    await cleanTestData(testDb);
  }, 180000); // 3 minute timeout for container startup

  afterAll(async () => {
    await app.close();
    await stopTestDatabase();
  });

  it("should reject request without Idempotency-Key header", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/payments",
      payload: {
        amount: 100,
        currency: "USD",
        customer_email: "test@example.com",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toContain("Idempotency-Key");
  });

  it("should reject invalid payload", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/payments",
      headers: {
        "idempotency-key": "test-key-invalid",
      },
      payload: {
        amount: -10, // Invalid: negative amount
        currency: "USD",
        customer_email: "test@example.com",
      },
    });

    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.body).error).toBe("Validation error");
  });

  it("should create payment successfully with mocked provider", async () => {
    // Mock provider success
    vi.spyOn(
      PaymentProviderClient.prototype,
      "createCharge",
    ).mockResolvedValueOnce({
      id: "ch_test123",
      status: "succeeded",
      amount: 100,
      currency: "USD",
    });

    const response = await app.inject({
      method: "POST",
      url: "/payments",
      headers: {
        "idempotency-key": "test-key-001",
      },
      payload: {
        amount: 100,
        currency: "USD",
        customer_email: "test@example.com",
        description: "Test payment",
      },
    });

    expect(response.statusCode).toBe(201);

    const body = JSON.parse(response.body);
    expect(body.status).toBe("completed");
    expect(body.amount).toBe(100);
    expect(body.currency).toBe("USD");
    expect(body.customer_email).toBe("test@example.com");
    expect(body.provider_id).toBe("ch_test123");
    expect(body.id).toBeDefined();

    vi.restoreAllMocks();
  });

  it("should return cached response for retry with same key and payload", async () => {
    // Mock provider (should NOT be called on retry)
    const mockCreateCharge = vi
      .spyOn(PaymentProviderClient.prototype, "createCharge")
      .mockResolvedValue({
        id: "ch_test456",
        status: "succeeded",
        amount: 200,
        currency: "USD",
      });

    // First request
    const response1 = await app.inject({
      method: "POST",
      url: "/payments",
      headers: {
        "idempotency-key": "test-key-002",
      },
      payload: {
        amount: 200,
        currency: "USD",
        customer_email: "test2@example.com",
      },
    });

    expect(response1.statusCode).toBe(201);
    expect(mockCreateCharge).toHaveBeenCalledTimes(1);

    const firstBody = JSON.parse(response1.body);

    // Retry with same key and payload
    const response2 = await app.inject({
      method: "POST",
      url: "/payments",
      headers: {
        "idempotency-key": "test-key-002",
      },
      payload: {
        amount: 200,
        currency: "USD",
        customer_email: "test2@example.com",
      },
    });

    expect(response2.statusCode).toBe(201);
    expect(mockCreateCharge).toHaveBeenCalledTimes(1); // Still 1, not called again

    const secondBody = JSON.parse(response2.body);

    // Should return exact same payment
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.provider_id).toBe(firstBody.provider_id);

    vi.restoreAllMocks();
  });

  it("should reject retry with same key but different payload (409 Conflict)", async () => {
    // Mock provider
    vi.spyOn(PaymentProviderClient.prototype, "createCharge").mockResolvedValue(
      {
        id: "ch_test789",
        status: "succeeded",
        amount: 300,
        currency: "USD",
      },
    );

    // First request
    const response1 = await app.inject({
      method: "POST",
      url: "/payments",
      headers: {
        "idempotency-key": "test-key-003",
      },
      payload: {
        amount: 300,
        currency: "USD",
        customer_email: "test3@example.com",
      },
    });

    expect(response1.statusCode).toBe(201);

    // Retry with same key but DIFFERENT payload
    const response2 = await app.inject({
      method: "POST",
      url: "/payments",
      headers: {
        "idempotency-key": "test-key-003",
      },
      payload: {
        amount: 999, // Different amount!
        currency: "USD",
        customer_email: "test3@example.com",
      },
    });

    expect(response2.statusCode).toBe(409);
    expect(JSON.parse(response2.body).error).toContain("different payload");

    vi.restoreAllMocks();
  });

  it("should handle provider timeout and mark as REQUIRES_RECONCILIATION", async () => {
    // Mock provider timeout
    vi.spyOn(
      PaymentProviderClient.prototype,
      "createCharge",
    ).mockRejectedValueOnce(new Error("Provider request timeout"));

    const response = await app.inject({
      method: "POST",
      url: "/payments",
      headers: {
        "idempotency-key": "test-key-004-timeout",
      },
      payload: {
        amount: 400,
        currency: "USD",
        customer_email: "test4@example.com",
      },
    });

    expect(response.statusCode).toBe(500);

    const body = JSON.parse(response.body);
    expect(body.status).toBe("requires_reconciliation");
    expect(body.failure_reason).toContain("timeout");

    vi.restoreAllMocks();
  });
});
