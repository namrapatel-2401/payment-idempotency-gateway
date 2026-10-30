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
import { PaymentProviderClient } from "../../src/services/provider.client.js";
import {
  startTestDatabase,
  stopTestDatabase,
  cleanTestData,
} from "../setup/test-db.js";

describe("Concurrency & Race Conditions - Integration", () => {
  let app: FastifyInstance;
  let testDb: Knex;

  beforeAll(async () => {
    const dbSetup = await startTestDatabase();
    testDb = dbSetup.db;

    process.env.DB_HOST = dbSetup.connectionConfig.host;
    process.env.DB_PORT = String(dbSetup.connectionConfig.port);
    process.env.DB_NAME = dbSetup.connectionConfig.database;
    process.env.DB_USER = dbSetup.connectionConfig.user;
    process.env.DB_PASSWORD = dbSetup.connectionConfig.password;

    app = await buildApp();
    await app.ready();
  }, 180000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase();
  });

  beforeEach(async () => {
    await cleanTestData(testDb);
    vi.restoreAllMocks();
  });

  it("should handle 10 concurrent requests with the same key and create exactly 1 payment", async () => {
    let providerCallCount = 0;

    // Mock provider with artificial delay to increase race condition window
    vi.spyOn(
      PaymentProviderClient.prototype,
      "createCharge",
    ).mockImplementation(async () => {
      providerCallCount++;
      // Simulate network latency
      await new Promise((resolve) => setTimeout(resolve, 200));
      return {
        id: `ch_test_${Date.now()}`,
        status: "succeeded",
        amount: 100,
        currency: "USD",
      };
    });

    const idempotencyKey = "concurrent-test-key-001";
    const payload = {
      amount: 100,
      currency: "USD",
      customer_email: "concurrent@example.com",
      description: "Concurrent payment test",
    };

    // Fire 10 requests simultaneously
    const requests = Array.from({ length: 10 }, () =>
      app.inject({
        method: "POST",
        url: "/payments",
        headers: {
          "idempotency-key": idempotencyKey,
        },
        payload,
      }),
    );

    const responses = await Promise.all(requests);

    // Count response status codes
    const statusCodes = responses.map((r) => r.statusCode);
    const successResponses = responses.filter((r) => r.statusCode === 201);
    const inFlightResponses = responses.filter((r) => r.statusCode === 423);

    // Expectations:
    // 1. All responses should be either 201 (success/cached) or 423 (locked/in-flight)
    expect(statusCodes.every((code) => code === 201 || code === 423)).toBe(
      true,
    );

    // 2. At least one request must succeed
    expect(successResponses.length).toBeGreaterThan(0);

    // 3. Provider should be called EXACTLY ONCE
    expect(providerCallCount).toBe(1);

    // 4. Exactly one payment record in the database
    const payments = await testDb("payments").select("*");
    expect(payments.length).toBe(1);

    // 5. Exactly one idempotency key record in the database
    const keys = await testDb("idempotency_keys").select("*");
    expect(keys.length).toBe(1);
    expect(keys[0].status).toBe("completed");

    // 6. All successful responses should return the SAME payment ID
    const paymentIds = successResponses.map((r) => JSON.parse(r.body).id);
    const uniquePaymentIds = new Set(paymentIds);
    expect(uniquePaymentIds.size).toBe(1);
  });

  it("should allow retry after in-flight request finishes", async () => {
    vi.spyOn(
      PaymentProviderClient.prototype,
      "createCharge",
    ).mockResolvedValueOnce({
      id: "ch_test_retry",
      status: "succeeded",
      amount: 150,
      currency: "USD",
    });

    const idempotencyKey = "concurrent-retry-key-002";
    const payload = {
      amount: 150,
      currency: "USD",
      customer_email: "retry@example.com",
    };

    // First request
    const response1 = await app.inject({
      method: "POST",
      url: "/payments",
      headers: {
        "idempotency-key": idempotencyKey,
      },
      payload,
    });

    expect(response1.statusCode).toBe(201);
    const payment1 = JSON.parse(response1.body);

    // Subsequent retry
    const response2 = await app.inject({
      method: "POST",
      url: "/payments",
      headers: {
        "idempotency-key": idempotencyKey,
      },
      payload,
    });

    expect(response2.statusCode).toBe(201);
    const payment2 = JSON.parse(response2.body);

    // Should return identical payment
    expect(payment2.id).toBe(payment1.id);
    expect(payment2.provider_id).toBe("ch_test_retry");
  });
});
