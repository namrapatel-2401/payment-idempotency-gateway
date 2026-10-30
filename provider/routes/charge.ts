import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { providerConfig } from '../config.js';
import {
  findChargeByIdempotencyKey,
  findChargeById,
  createCharge,
} from '../db.js';

interface ChargeRequest {
  amount: number;
  currency: string;
  customer_email: string;
  description?: string;
  metadata?: Record<string, any>;
}

const hashRequestBody = (body: ChargeRequest): string => {
  const normalized = JSON.stringify({
    amount: body.amount,
    currency: body.currency,
    customer_email: body.customer_email,
    description: body.description || '',
  });
  return crypto.createHash('sha256').update(normalized).digest('hex');
};

const simulateLatency = async (): Promise<void> => {
  const latency =
    providerConfig.minLatencyMs +
    Math.random() * (providerConfig.maxLatencyMs - providerConfig.minLatencyMs);
  await new Promise((resolve) => setTimeout(resolve, latency));
};

const shouldTimeout = (): boolean => {
  return Math.random() < providerConfig.timeoutRate;
};

const shouldFail = (): boolean => {
  return Math.random() < providerConfig.failureRate;
};

export const chargeRoutes = async (app: FastifyInstance) => {
  // POST /provider/charge - Create charge with provider idempotency
  app.post('/charge', async (request: FastifyRequest, reply: FastifyReply) => {
    const idempotencyKey = request.headers['idempotency-key'] as string;

    if (!idempotencyKey) {
      return reply.status(400).send({
        error: 'Idempotency-Key header is required',
      });
    }

    const body = request.body as ChargeRequest;

    // Validate request
    if (!body.amount || body.amount <= 0) {
      return reply.status(400).send({ error: 'Invalid amount' });
    }

    if (!body.currency || !body.customer_email) {
      return reply.status(400).send({ error: 'Missing required fields' });
    }

    const requestHash = hashRequestBody(body);

    // Check if idempotency key already exists
    const existingCharge = findChargeByIdempotencyKey(idempotencyKey);
    if (existingCharge) {
      // Provider-side idempotency: return cached response
      if (existingCharge.request_hash !== requestHash) {
        return reply.status(409).send({
          error: 'Idempotency key reused with different payload',
        });
      }

      app.log.info(
        { charge_id: existingCharge.id, idempotency_key: idempotencyKey },
        'Provider: Returning cached charge (idempotency hit)'
      );

      return reply.status(200).send({
        id: existingCharge.id,
        status: existingCharge.status,
        amount: existingCharge.amount,
        currency: existingCharge.currency,
        failure_message: existingCharge.failure_message,
      });
    }

    // Simulate network latency
    await simulateLatency();

    // Simulate timeout (never responds)
    if (shouldTimeout()) {
      app.log.warn(
        { idempotency_key: idempotencyKey },
        'Provider: Simulating timeout (no response)'
      );
      // Hang the request without responding
      await new Promise(() => {}); // Never resolves
      return;
    }

    // Simulate failure
    const willFail = shouldFail();

    const charge = createCharge(idempotencyKey, requestHash, {
      amount: body.amount,
      currency: body.currency,
      customer_email: body.customer_email,
      description: body.description,
      status: willFail ? 'failed' : 'succeeded',
      failure_message: willFail
        ? 'Simulated provider failure'
        : undefined,
    });

    app.log.info(
      {
        charge_id: charge.id,
        idempotency_key: idempotencyKey,
        status: charge.status,
      },
      'Provider: Charge created'
    );

    return reply.status(200).send({
      id: charge.id,
      status: charge.status,
      amount: charge.amount,
      currency: charge.currency,
      failure_message: charge.failure_message,
    });
  });

  // GET /provider/charge/by-idempotency-key/:key - Reconciliation lookup
  app.get(
    '/charge/by-idempotency-key/:key',
    async (request: FastifyRequest<{ Params: { key: string } }>, reply: FastifyReply) => {
      const { key } = request.params;

      const charge = findChargeByIdempotencyKey(key);

      if (!charge) {
        return reply.status(404).send({
          error: 'No charge found for this idempotency key',
        });
      }

      app.log.info(
        { charge_id: charge.id, idempotency_key: key },
        'Provider: Reconciliation lookup'
      );

      return reply.status(200).send({
        id: charge.id,
        status: charge.status,
        amount: charge.amount,
        currency: charge.currency,
        failure_message: charge.failure_message,
      });
    }
  );

  // GET /provider/charge/:id - Get charge by ID
  app.get(
    '/charge/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;

      const charge = findChargeById(id);

      if (!charge) {
        return reply.status(404).send({
          error: 'Charge not found',
        });
      }

      return reply.status(200).send({
        id: charge.id,
        status: charge.status,
        amount: charge.amount,
        currency: charge.currency,
        failure_message: charge.failure_message,
      });
    }
  );
};
