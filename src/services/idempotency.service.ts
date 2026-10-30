import { getDb } from "../db/connection.js";
import { IdempotencyKeyRepository } from "../db/repositories/idempotency-key.repository.js";
import { PaymentRepository } from "../db/repositories/payment.repository.js";
import { PaymentProviderClient } from "./provider.client.js";
import {
  hashRequestBody,
  deriveProviderIdempotencyKey,
} from "../utils/hash.js";
import {
  IdempotencyConflictError,
  IdempotencyKeyInFlightError,
} from "../errors/index.js";
import {
  PaymentStatus,
  IdempotencyKeyStatus,
} from "../models/payment-status.js";
import {
  CreatePaymentRequest,
  PaymentResponse,
  PaymentEventType,
} from "../models/payment.js";

const STALE_LOCK_THRESHOLD_MS = 30000; // 30 seconds

export class IdempotencyService {
  private idempotencyRepo: IdempotencyKeyRepository;
  private paymentRepo: PaymentRepository;
  private providerClient: PaymentProviderClient;

  constructor() {
    this.idempotencyRepo = new IdempotencyKeyRepository();
    this.paymentRepo = new PaymentRepository();
    this.providerClient = new PaymentProviderClient();
  }

  /**
   * Process payment with full idempotency guarantees
   */
  async processPayment(
    idempotencyKey: string,
    requestPath: string,
    requestBody: CreatePaymentRequest,
  ): Promise<{ statusCode: number; body: PaymentResponse }> {
    const requestHash = hashRequestBody(requestBody);

    // Transaction 1: Acquire key and create payment record
    const { keyRecord } = await getDb().transaction(async (_trx) => {
      // Try to insert idempotency key (INSERT ... ON CONFLICT DO NOTHING)
      await this.idempotencyRepo.create({
        key: idempotencyKey,
        request_path: requestPath,
        request_hash: requestHash,
      });

      // Acquire row lock (SELECT ... FOR UPDATE)
      const key = await this.idempotencyRepo.findAndLock(idempotencyKey);

      if (!key) {
        throw new Error("Failed to acquire idempotency key lock");
      }

      return { keyRecord: key };
    });

    // Branch on key status
    switch (keyRecord.status) {
      case IdempotencyKeyStatus.PENDING:
        return await this.handleNewPayment(keyRecord, requestHash, requestBody);

      case IdempotencyKeyStatus.COMPLETED:
      case IdempotencyKeyStatus.FAILED:
        return await this.handleCompletedKey(keyRecord, requestHash);

      case IdempotencyKeyStatus.PROCESSING:
        return await this.handleInFlightKey(keyRecord, requestHash);

      case IdempotencyKeyStatus.REQUIRES_RECONCILIATION:
        return await this.handleReconciliation(
          keyRecord,
          requestHash,
          requestBody,
        );

      default:
        throw new Error(`Unknown idempotency key status: ${keyRecord.status}`);
    }
  }

  /**
   * Handle new payment (status = PENDING)
   */
  private async handleNewPayment(
    keyRecord: any,
    _requestHash: string,
    requestBody: CreatePaymentRequest,
  ): Promise<{ statusCode: number; body: PaymentResponse }> {
    // Derive provider idempotency key
    const providerIdempotencyKey = deriveProviderIdempotencyKey(keyRecord.key);

    // Create payment record and mark key as PROCESSING
    const payment = await getDb().transaction(async (_trx) => {
      const p = await this.paymentRepo.create({
        idempotency_key_id: keyRecord.id,
        provider_idempotency_key: providerIdempotencyKey,
        amount: requestBody.amount,
        currency: requestBody.currency,
        customer_email: requestBody.customer_email,
        description: requestBody.description,
        metadata: requestBody.metadata,
      });

      await this.idempotencyRepo.updateStatus(
        keyRecord.id,
        IdempotencyKeyStatus.PROCESSING,
        new Date(),
      );

      await this.paymentRepo.createEvent({
        payment_id: p.id,
        event_type: PaymentEventType.CREATED,
        details: { status: PaymentStatus.PENDING },
      });

      return p;
    });

    // Call provider OUTSIDE transaction
    let providerResponse;
    let providerError: Error | null = null;

    try {
      providerResponse = await this.providerClient.createCharge(
        providerIdempotencyKey,
        {
          amount: requestBody.amount,
          currency: requestBody.currency,
          customer_email: requestBody.customer_email,
          description: requestBody.description,
          metadata: requestBody.metadata,
        },
      );
    } catch (error) {
      providerError = error as Error;
    }

    // Transaction 2: Save provider result
    if (providerResponse) {
      return await this.saveProviderSuccess(
        keyRecord.id,
        payment.id,
        providerResponse,
      );
    } else {
      return await this.saveProviderFailure(
        keyRecord.id,
        payment.id,
        providerError!,
      );
    }
  }

  /**
   * Save successful provider response
   */
  private async saveProviderSuccess(
    keyId: string,
    paymentId: string,
    providerResponse: any,
  ): Promise<{ statusCode: number; body: PaymentResponse }> {
    const result = await getDb().transaction(async (_trx) => {
      await this.paymentRepo.updateStatus(paymentId, PaymentStatus.COMPLETED, {
        provider_id: providerResponse.id,
        provider_status: providerResponse.status,
      });

      await this.paymentRepo.createEvent({
        payment_id: paymentId,
        event_type: PaymentEventType.COMPLETED,
        details: {
          provider_id: providerResponse.id,
          provider_status: providerResponse.status,
        },
      });

      const payment = await this.paymentRepo.findById(paymentId);
      const responseBody = this.formatPaymentResponse(payment!);

      await this.idempotencyRepo.cacheResponse(
        keyId,
        201,
        responseBody,
        IdempotencyKeyStatus.COMPLETED,
      );

      return responseBody;
    });

    return { statusCode: 201, body: result };
  }

  /**
   * Save provider failure
   */
  private async saveProviderFailure(
    keyId: string,
    paymentId: string,
    error: Error,
  ): Promise<{ statusCode: number; body: PaymentResponse }> {
    const isTimeout = error.message.includes("timeout");
    const newStatus = isTimeout
      ? PaymentStatus.REQUIRES_RECONCILIATION
      : PaymentStatus.FAILED;

    const result = await getDb().transaction(async (_trx) => {
      await this.paymentRepo.updateStatus(paymentId, newStatus, {
        failure_reason: error.message,
      });

      await this.paymentRepo.createEvent({
        payment_id: paymentId,
        event_type: isTimeout
          ? PaymentEventType.REQUIRES_RECONCILIATION
          : PaymentEventType.FAILED,
        details: { error: error.message },
      });

      const payment = await this.paymentRepo.findById(paymentId);
      const responseBody = this.formatPaymentResponse(payment!);

      await this.idempotencyRepo.cacheResponse(
        keyId,
        isTimeout ? 500 : 502,
        responseBody,
        isTimeout
          ? IdempotencyKeyStatus.REQUIRES_RECONCILIATION
          : IdempotencyKeyStatus.FAILED,
      );

      return responseBody;
    });

    return {
      statusCode: result.status === "requires_reconciliation" ? 500 : 502,
      body: result,
    };
  }

  /**
   * Handle completed/failed key (return cached response)
   */
  private async handleCompletedKey(
    keyRecord: any,
    requestHash: string,
  ): Promise<{ statusCode: number; body: PaymentResponse }> {
    // Verify hash matches (detect key reuse with different payload)
    if (keyRecord.request_hash !== requestHash) {
      throw new IdempotencyConflictError();
    }

    // Return cached response
    return {
      statusCode: keyRecord.response_code,
      body: keyRecord.response_body,
    };
  }

  /**
   * Handle in-flight key (status = PROCESSING)
   */
  private async handleInFlightKey(
    keyRecord: any,
    requestHash: string,
  ): Promise<{ statusCode: number; body: PaymentResponse }> {
    // Verify hash matches
    if (keyRecord.request_hash !== requestHash) {
      throw new IdempotencyConflictError();
    }

    // Check if lock is stale
    const lockAge = Date.now() - new Date(keyRecord.locked_at).getTime();
    if (lockAge > STALE_LOCK_THRESHOLD_MS) {
      // Mark as REQUIRES_RECONCILIATION
      await this.idempotencyRepo.updateStatus(
        keyRecord.id,
        IdempotencyKeyStatus.REQUIRES_RECONCILIATION,
      );

      throw new Error(
        "Previous request appears to have crashed. Retry to reconcile.",
      );
    }

    // Lock is fresh, another request is actively processing
    throw new IdempotencyKeyInFlightError();
  }

  /**
   * Handle reconciliation (status = REQUIRES_RECONCILIATION)
   */
  private async handleReconciliation(
    keyRecord: any,
    requestHash: string,
    requestBody: CreatePaymentRequest,
  ): Promise<{ statusCode: number; body: PaymentResponse }> {
    // Verify hash matches
    if (keyRecord.request_hash !== requestHash) {
      throw new IdempotencyConflictError();
    }

    // Find payment record
    const payment = await this.paymentRepo.findByIdempotencyKeyId(keyRecord.id);
    if (!payment) {
      throw new Error("Payment record not found for reconciliation");
    }

    // Query provider with provider_idempotency_key
    const providerCharge = await this.providerClient.getChargeByIdempotencyKey(
      payment.provider_idempotency_key,
    );

    if (providerCharge) {
      // Provider succeeded, reconcile to COMPLETED
      return await this.saveProviderSuccess(
        keyRecord.id,
        payment.id,
        providerCharge,
      );
    } else {
      // Provider has no record, retry the charge
      await this.idempotencyRepo.updateStatus(
        keyRecord.id,
        IdempotencyKeyStatus.PROCESSING,
        new Date(),
      );

      let providerResponse;
      let providerError: Error | null = null;

      try {
        providerResponse = await this.providerClient.createCharge(
          payment.provider_idempotency_key,
          {
            amount: requestBody.amount,
            currency: requestBody.currency,
            customer_email: requestBody.customer_email,
            description: requestBody.description,
            metadata: requestBody.metadata,
          },
        );
      } catch (error) {
        providerError = error as Error;
      }

      if (providerResponse) {
        return await this.saveProviderSuccess(
          keyRecord.id,
          payment.id,
          providerResponse,
        );
      } else {
        return await this.saveProviderFailure(
          keyRecord.id,
          payment.id,
          providerError!,
        );
      }
    }
  }

  /**
   * Format payment record as API response
   */
  private formatPaymentResponse(payment: any): PaymentResponse {
    return {
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
  }
}
