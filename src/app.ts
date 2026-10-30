import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rawBody from "fastify-raw-body";
import { config } from "./config.js";
import { checkDbHealth } from "./db/connection.js";
import { paymentRoutes } from "./routes/payments.js";
import { webhookRoutes } from "./routes/webhooks.js";

export const buildApp = async (): Promise<FastifyInstance> => {
  const app = Fastify({
    logger: config.nodeEnv === "development",
    requestIdLogLabel: "reqId",
    disableRequestLogging: false,
    requestIdHeader: "x-request-id",
  });

  // Register raw body parser (for HMAC webhook verification)
  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true,
  });

  // Register plugins
  await app.register(helmet, {
    contentSecurityPolicy: false,
  });

  await app.register(cors, {
    origin: config.nodeEnv === "development" ? "*" : false,
  });

  // Register routes
  await app.register(paymentRoutes);
  await app.register(webhookRoutes);

  // Health check endpoint
  app.get("/health", async (_request, reply) => {
    const dbHealthy = await checkDbHealth();

    const health = {
      status: dbHealthy ? "healthy" : "unhealthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: dbHealthy ? "connected" : "disconnected",
    };

    if (!dbHealthy) {
      return reply.status(503).send(health);
    }

    return reply.status(200).send(health);
  });

  return app;
};
