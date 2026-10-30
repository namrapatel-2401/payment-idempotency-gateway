import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { providerConfig } from '../config.js';

interface ConfigUpdateRequest {
  failureRate?: number;
  timeoutRate?: number;
  minLatencyMs?: number;
  maxLatencyMs?: number;
}

export const configRoutes = async (app: FastifyInstance) => {
  // GET /provider/config - Get current configuration
  app.get('/config', async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(200).send({
      port: providerConfig.port,
      failureRate: providerConfig.failureRate,
      timeoutRate: providerConfig.timeoutRate,
      minLatencyMs: providerConfig.minLatencyMs,
      maxLatencyMs: providerConfig.maxLatencyMs,
    });
  });

  // POST /provider/config - Update configuration at runtime
  app.post('/config', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as ConfigUpdateRequest;

    if (body.failureRate !== undefined) {
      if (body.failureRate < 0 || body.failureRate > 1) {
        return reply.status(400).send({
          error: 'failureRate must be between 0 and 1',
        });
      }
      providerConfig.failureRate = body.failureRate;
    }

    if (body.timeoutRate !== undefined) {
      if (body.timeoutRate < 0 || body.timeoutRate > 1) {
        return reply.status(400).send({
          error: 'timeoutRate must be between 0 and 1',
        });
      }
      providerConfig.timeoutRate = body.timeoutRate;
    }

    if (body.minLatencyMs !== undefined) {
      if (body.minLatencyMs < 0) {
        return reply.status(400).send({
          error: 'minLatencyMs must be >= 0',
        });
      }
      providerConfig.minLatencyMs = body.minLatencyMs;
    }

    if (body.maxLatencyMs !== undefined) {
      if (body.maxLatencyMs < 0) {
        return reply.status(400).send({
          error: 'maxLatencyMs must be >= 0',
        });
      }
      providerConfig.maxLatencyMs = body.maxLatencyMs;
    }

    app.log.info(
      {
        failureRate: providerConfig.failureRate,
        timeoutRate: providerConfig.timeoutRate,
        minLatencyMs: providerConfig.minLatencyMs,
        maxLatencyMs: providerConfig.maxLatencyMs,
      },
      'Provider config updated'
    );

    return reply.status(200).send({
      port: providerConfig.port,
      failureRate: providerConfig.failureRate,
      timeoutRate: providerConfig.timeoutRate,
      minLatencyMs: providerConfig.minLatencyMs,
      maxLatencyMs: providerConfig.maxLatencyMs,
    });
  });
};
