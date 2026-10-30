import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { FastifyInstance } from "fastify";
import * as dbConnection from "../../src/db/connection.js";
import { buildApp } from "../../src/app.js";

describe("Health Check Endpoint", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("should return 200 when database is healthy", async () => {
    vi.spyOn(dbConnection, "checkDbHealth").mockResolvedValueOnce(true);

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("status", "healthy");
    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("uptime");
    expect(body).toHaveProperty("database", "connected");
  });

  it("should return 503 when database is unhealthy", async () => {
    vi.spyOn(dbConnection, "checkDbHealth").mockResolvedValueOnce(false);

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(503);

    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("status", "unhealthy");
    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("database", "disconnected");
  });
});
