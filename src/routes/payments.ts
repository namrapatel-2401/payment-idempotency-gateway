import { FastifyInstance } from "fastify";
import { IdempotencyService } from "../services/idempotency.service.js";
import { PaymentRepository } from "../db/repositories/payment.repository.js";
import {
  createPaymentSchema,
  paymentResponseSchema,
  CreatePaymentRequest,
} from "../models/payment.js";
import {
  IdempotencyConflictError,
  IdempotencyKeyInFlightError,
  PaymentNotFoundError,
} from "../errors/index.js";

export async function paymentRoutes(app: FastifyInstance) {
  const idempotencyService = new IdempotencyService();
  const paymentRepo = new PaymentRepository();

  /**
   * POST /payments - Create payment (requires Idempotency-Key header)
   */
  app.post("/payments", async (request, reply) => {
    // Validate Idempotency-Key header
    const idempotencyKey = request.headers["idempotency-key"] as string;
    if (!idempotencyKey) {
      return reply.code(400).send({
        error: "Missing required header: Idempotency-Key",
      });
    }

    if (idempotencyKey.length > 255) {
      return reply.code(400).send({
        error: "Idempotency-Key must be 255 characters or less",
      });
    }

    // Validate request body
    let validatedBody: CreatePaymentRequest;
    try {
      validatedBody = createPaymentSchema.parse(request.body);
    } catch (error: any) {
      return reply.code(422).send({
        error: "Validation error",
        details: error.errors || error.message,
      });
    }

    // Process payment with idempotency guarantees
    try {
      const result = await idempotencyService.processPayment(
        idempotencyKey,
        request.url,
        validatedBody,
      );

      // Validate response against schema before sending
      const validatedResponse = paymentResponseSchema.parse(result.body);

      return reply.code(result.statusCode).send(validatedResponse);
    } catch (error: any) {
      request.log.error(error, "Payment processing error");

      if (error instanceof IdempotencyConflictError) {
        return reply.code(409).send({
          error: "Idempotency key reused with different payload",
        });
      }

      if (error instanceof IdempotencyKeyInFlightError) {
        return reply.code(423).send({
          error: "Another request with this key is processing",
        });
      }

      return reply.code(500).send({
        error: "Internal server error",
        message: error.message,
      });
    }
  });

  /**
   * GET /payments/:id - Get payment by ID
   */
  app.get<{ Params: { id: string } }>(
    "/payments/:id",
    async (request, reply) => {
      const { id } = request.params;

      try {
        const payment = await paymentRepo.findById(id);

        if (!payment) {
          throw new PaymentNotFoundError();
        }

        const response = {
          id: payment.id,
          amount: parseFloat(payment.amount),
          currency: payment.currency,
          customer_email: payment.customer_email,
          description: payment.description,
          status: payment.status,
          provider_id: payment.provider_id,
          provider_status: payment.provider_status,
          failure_reason: payment.failure_reason,
          metadata:
            typeof payment.metadata === "string"
              ? JSON.parse(payment.metadata)
              : payment.metadata,
          created_at: payment.created_at.toISOString(),
          updated_at: payment.updated_at.toISOString(),
        };

        const validatedResponse = paymentResponseSchema.parse(response);

        return reply.code(200).send(validatedResponse);
      } catch (error: any) {
        request.log.error(error, "Get payment error");

        if (error instanceof PaymentNotFoundError) {
          return reply.code(404).send({
            error: "Payment not found",
          });
        }

        return reply.code(500).send({
          error: "Internal server error",
          message: error.message,
        });
      }
    },
  );
}
