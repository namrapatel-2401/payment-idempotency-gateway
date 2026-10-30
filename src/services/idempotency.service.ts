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
  IdempotencyKey,
  Payment,
  PaymentResponse,
  PaymentEventType,
} from "../models/payment.js";
import {
  applyProviderObservation,
  ProviderObservation,
} from "./provider-observation.service.js";
import { hashCanonicalJson } from "../utils/canonical-json.js";
import crypto from "crypto";

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

    // Transaction 1: acquire the key and, for a new request, create its local claim.
    const acquisition = await getDb().transaction(async (trx) => {
      // Try to insert idempotency key (INSERT ... ON CONFLICT DO NOTHING)
      await this.idempotencyRepo.create({
        key: idempotencyKey,
        request_path: requestPath,
        request_hash: requestHash,
      }, trx);

      // Acquire row lock (SELECT ... FOR UPDATE)
      const key = await this.idempotencyRepo.findAndLock(idempotencyKey, trx);

      if (!key) {
        throw new Error("Failed to acquire idempotency key lock");
      }

      if (key.request_hash !== requestHash) {
        throw new IdempotencyConflictError();
      }

      switch (key.status) {
        case IdempotencyKeyStatus.PENDING: {
          const claimGeneration = key.claim_generation + 1;
          const payment = await this.paymentRepo.create(
            {
              idempotency_key_id: key.id,
              provider_idempotency_key: deriveProviderIdempotencyKey(key.key),
              amount: requestBody.amount,
              currency: requestBody.currency,
              customer_email: requestBody.customer_email,
              description: requestBody.description,
              metadata: requestBody.metadata,
            },
            trx,
          );

          await this.idempotencyRepo.updateStatus(
            key.id,
            IdempotencyKeyStatus.PROCESSING,
            new Date(),
            claimGeneration,
            trx,
          );

          await this.paymentRepo.createEvent(
            {
              payment_id: payment.id,
              event_type: PaymentEventType.CREATED,
              details: { status: PaymentStatus.PENDING },
            },
            trx,
          );

          return {
            kind: "new" as const,
            keyRecord: key,
            payment,
            claimGeneration,
          };
        }

        case IdempotencyKeyStatus.COMPLETED:
        case IdempotencyKeyStatus.FAILED: {
          return { kind: "cached" as const, keyRecord: key };
        }

        case IdempotencyKeyStatus.PROCESSING: {
          const lockAge = key.locked_at
            ? Date.now() - new Date(key.locked_at).getTime()
            : Number.POSITIVE_INFINITY;

          if (lockAge > STALE_LOCK_THRESHOLD_MS) {
            // Reclaim the ownership generation for reconciliation. The old
            // worker can no longer persist a provider result with its token.
            await this.idempotencyRepo.updateStatus(
              key.id,
              IdempotencyKeyStatus.REQUIRES_RECONCILIATION,
              null,
              key.claim_generation + 1,
              trx,
            );

            return { kind: "stale" as const };
          }

          return { kind: "in_flight" as const };
        }

        case IdempotencyKeyStatus.REQUIRES_RECONCILIATION:
          return { kind: "reconcile" as const, keyRecord: key };

        default:
          throw new Error(`Unknown idempotency key status: ${key.status}`);
      }
    });

    switch (acquisition.kind) {
      case "new":
        return await this.handleNewPayment(
          acquisition.keyRecord,
          acquisition.payment,
          acquisition.claimGeneration,
          requestBody,
        );
      case "cached":
        {
          const conflictResult = await this.resolvePendingTerminalConflict(
            acquisition.keyRecord,
          );
          if (conflictResult) return conflictResult;
        }
        return await this.handleCompletedKey(acquisition.keyRecord, requestHash);
      case "in_flight":
        throw new IdempotencyKeyInFlightError();
      case "stale":
        throw new Error(
          "Previous request appears to have crashed. Retry to reconcile.",
        );
      case "reconcile":
        return await this.handleReconciliation(
          acquisition.keyRecord,
          requestHash,
          requestBody,
        );
    }
  }

  /**
   * Handle new payment (status = PENDING)
   */
  private async handleNewPayment(
    keyRecord: IdempotencyKey,
    payment: Payment,
    claimGeneration: number,
    requestBody: CreatePaymentRequest,
  ): Promise<{ statusCode: number; body: PaymentResponse }> {
    // Call provider OUTSIDE transaction
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

    // Transaction 2: Save provider result
    if (providerResponse) {
      return await this.saveProviderObservation(
        keyRecord.id,
        payment.id,
        providerResponse,
        claimGeneration,
      );
    } else {
      return await this.saveProviderFailure(
        keyRecord.id,
        payment.id,
        providerError!,
        claimGeneration,
      );
    }
  }

  /**
   * Save successful provider response
   */
  private async saveProviderObservation(
    keyId: string,
    paymentId: string,
    providerResponse: any,
    claimGeneration: number,
  ): Promise<{ statusCode: number; body: PaymentResponse }> {
    const result = await getDb().transaction(async (trx) => {
      await this.assertClaimOwner(keyId, paymentId, claimGeneration, trx);

      const payment = await this.paymentRepo.findById(paymentId, trx);
      if (!payment) throw new Error("Payment record not found for provider observation");

      const observation: ProviderObservation = {
        eventId: `provider-response:${providerResponse.id}`,
        chargeId: providerResponse.id,
        providerIdempotencyKey: payment.provider_idempotency_key,
        status: providerResponse.status,
        failureMessage: providerResponse.failure_message,
        providerRevision: providerResponse.provider_revision ?? null,
        providerEventAt: new Date(),
        payloadHash: hashCanonicalJson(providerResponse),
        payload: providerResponse as Record<string, unknown>,
        source: "reconciliation",
      };

      const applied = await applyProviderObservation(trx, observation);
      if (applied.kind !== "applied") {
        throw new Error(`Provider observation was not applied: ${applied.kind}`);
      }

      const responseBody = applied.payment;

      const orphaned = await trx("orphaned_webhooks")
        .where({
          provider_idempotency_key: payment.provider_idempotency_key,
          resolved: false,
        })
        .forUpdate();

      for (const orphan of orphaned) {
        const orphanPayload = orphan.payload as any;
        const orphanObservation: ProviderObservation = {
          eventId: orphan.webhook_id,
          chargeId: orphan.charge_id,
          providerIdempotencyKey: orphan.provider_idempotency_key,
          status: orphanPayload.status,
          failureMessage: orphanPayload.failure_message,
          providerRevision: orphanPayload.provider_revision ?? 1,
          providerEventAt: orphanPayload.timestamp
            ? new Date(orphanPayload.timestamp)
            : null,
          payloadHash: orphan.payload_hash || hashCanonicalJson(orphanPayload),
          payload: orphanPayload,
          source: "webhook",
        };
        await applyProviderObservation(trx, orphanObservation);
        await trx("orphaned_webhooks").where({ id: orphan.id }).update({
          resolved: true,
          resolved_at: trx.fn.now(),
        });
      }

      return responseBody;
    });

    return {
      statusCode: result.status === PaymentStatus.COMPLETED ? 201 : 502,
      body: result,
    };
  }

  /**
   * Save provider failure
   */
  private async saveProviderFailure(
    keyId: string,
    paymentId: string,
    error: Error,
    claimGeneration: number,
  ): Promise<{ statusCode: number; body: PaymentResponse }> {
    const isTimeout = error.message.includes("timeout");
    const newStatus = isTimeout
      ? PaymentStatus.REQUIRES_RECONCILIATION
      : PaymentStatus.FAILED;

    const result = await getDb().transaction(async (trx) => {
      await this.assertClaimOwner(keyId, paymentId, claimGeneration, trx);

      await this.paymentRepo.updateStatus(
        paymentId,
        newStatus,
        {
          failure_reason: error.message,
        },
        trx,
      );

      await this.paymentRepo.createEvent(
        {
          payment_id: paymentId,
          event_type: isTimeout
            ? PaymentEventType.REQUIRES_RECONCILIATION
            : PaymentEventType.FAILED,
          details: { error: error.message },
        },
        trx,
      );

      const updatedPayment = await this.paymentRepo.findById(paymentId, trx);
      const responseBody = this.formatPaymentResponse(updatedPayment!);

      await this.idempotencyRepo.cacheResponse(
        keyId,
        isTimeout ? 500 : 502,
        responseBody,
        isTimeout
          ? IdempotencyKeyStatus.REQUIRES_RECONCILIATION
          : IdempotencyKeyStatus.FAILED,
        trx,
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
    keyRecord: IdempotencyKey,
    requestHash: string,
  ): Promise<{ statusCode: number; body: PaymentResponse }> {
    // Verify hash matches (detect key reuse with different payload)
    if (keyRecord.request_hash !== requestHash) {
      throw new IdempotencyConflictError();
    }

    if (keyRecord.response_code === null || keyRecord.response_body === null) {
      throw new Error("Completed idempotency key has no cached response");
    }

    // Return cached response
    return {
      statusCode: keyRecord.response_code,
      body: keyRecord.response_body,
    };
  }

  /**
   * Terminal conflicts do not change the payment or cached response. A
   * short database lease prevents concurrent retries from issuing duplicate
   * provider lookups; an interrupted attempt becomes claimable after expiry.
   */
  private async resolvePendingTerminalConflict(
    keyRecord: IdempotencyKey,
  ): Promise<{ statusCode: number; body: PaymentResponse } | null> {
    const token = crypto.randomUUID();
    const claim = await getDb().transaction(async (trx) => {
      const conflict = await trx("provider_conflicts")
        .where({ idempotency_key_id: keyRecord.id, status: "pending" })
        .where((query) =>
          query
            .whereNull("resolution_locked_at")
            .orWhere(
              "resolution_locked_at",
              "<",
              new Date(Date.now() - 30000),
            ),
        )
        .orderBy("created_at", "asc")
        .first();
      if (!conflict) return null;

      // Preserve the global lock order before claiming the conflict row:
      // idempotency key -> payment -> provider conflict.
      const key = await trx("idempotency_keys")
        .where({ id: conflict.idempotency_key_id })
        .forUpdate()
        .first();
      const payment = await trx("payments")
        .where({ id: conflict.payment_id })
        .forUpdate()
        .first();
      if (!key || !payment) return null;

      const claimed = await trx("provider_conflicts")
        .where({
          id: conflict.id,
          status: "pending",
        })
        .where((query) =>
          query
            .whereNull("resolution_locked_at")
            .orWhere("resolution_locked_at", "<", new Date(Date.now() - 30000)),
        )
        .update({
          resolution_claim_token: token,
          resolution_locked_at: trx.fn.now(),
          resolution_attempts: trx.raw("resolution_attempts + 1"),
        });
      if (!claimed) return null;

      return { conflict, payment };
    });

    if (!claim || !claim.payment) return null;

    let providerCharge;
    try {
      providerCharge = await this.providerClient.getChargeByIdempotencyKey(
        claim.payment.provider_idempotency_key,
      );
    } catch {
      await getDb()("provider_conflicts")
        .where({ id: claim.conflict.id, resolution_claim_token: token })
        .update({ resolution_locked_at: null, resolution_claim_token: null });
      return null;
    }

    await getDb().transaction(async (trx) => {
      const key = await this.idempotencyRepo.findByIdAndLock(keyRecord.id, trx);
      const payment = await this.paymentRepo.findByIdAndLock(
        claim.payment.id,
        trx,
      );
      const currentConflict = await trx("provider_conflicts")
        .where({ id: claim.conflict.id, resolution_claim_token: token })
        .first();
      if (!key || !payment || !currentConflict) return;

      // A missing lookup result is inconclusive. Leave the durable conflict
      // pending so a later retry can resolve it without changing the cached
      // idempotency response.
      if (!providerCharge) {
        await trx("provider_conflicts")
          .where({ id: currentConflict.id, resolution_claim_token: token })
          .update({
            resolution_locked_at: null,
            resolution_claim_token: null,
          });
        return;
      }

      const expectedProviderStatus =
        payment.status === PaymentStatus.COMPLETED ? "succeeded" : "failed";
      const resolution =
        providerCharge.status === expectedProviderStatus
          ? "PROVIDER_CONFIRMED"
          : "TERMINAL_STATE_PRESERVED";

      await trx("payment_events").insert({
        payment_id: payment.id,
        event_type: PaymentEventType.WEBHOOK_CONFLICT_IGNORED,
        details: JSON.stringify({
          conflict_id: currentConflict.id,
          resolution,
          provider_status: providerCharge?.status ?? null,
          provider_revision: providerCharge?.provider_revision ?? null,
        }),
      });
      await trx("provider_conflicts")
        .where({ id: currentConflict.id, resolution_claim_token: token })
        .update({
          status: "resolved",
          resolution,
          resolved_at: trx.fn.now(),
          resolution_locked_at: null,
          resolution_claim_token: null,
        });
    });

    return null;
  }

  /**
   * Handle reconciliation (status = REQUIRES_RECONCILIATION)
   */
  private async handleReconciliation(
    keyRecord: IdempotencyKey,
    requestHash: string,
    requestBody: CreatePaymentRequest,
  ): Promise<{ statusCode: number; body: PaymentResponse }> {
    // Verify hash matches
    if (keyRecord.request_hash !== requestHash) {
      throw new IdempotencyConflictError();
    }

    const claim = await getDb().transaction(async (trx) => {
      const lockedKey = await this.idempotencyRepo.findByIdAndLock(
        keyRecord.id,
        trx,
      );
      if (!lockedKey || lockedKey.status !== IdempotencyKeyStatus.REQUIRES_RECONCILIATION) {
        throw new IdempotencyKeyInFlightError();
      }

      const payment = await this.paymentRepo.findByIdempotencyKeyIdAndLock(
        lockedKey.id,
        trx,
      );
      if (!payment) {
        throw new Error("Payment record not found for reconciliation");
      }

      const claimGeneration = lockedKey.claim_generation + 1;
      await this.idempotencyRepo.updateStatus(
        lockedKey.id,
        IdempotencyKeyStatus.PROCESSING,
        new Date(),
        claimGeneration,
        trx,
      );

      return { payment, claimGeneration };
    });

    const payment = claim.payment;

    // Query provider with provider_idempotency_key
    const providerCharge = await this.providerClient.getChargeByIdempotencyKey(
      payment.provider_idempotency_key,
    );

    if (providerCharge) {
      // Provider succeeded, reconcile to COMPLETED
      return await this.saveProviderObservation(
        keyRecord.id,
        payment.id,
        providerCharge,
        claim.claimGeneration,
      );
    } else {
      // Provider has no record, retry the charge
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
        return await this.saveProviderObservation(
          keyRecord.id,
          payment.id,
          providerResponse,
          claim.claimGeneration,
        );
      } else {
        return await this.saveProviderFailure(
          keyRecord.id,
          payment.id,
          providerError!,
          claim.claimGeneration,
        );
      }
    }
  }

  /**
   * Verify ownership before any provider result can modify local state.
   * Lock order is always idempotency key, then payment.
   */
  private async assertClaimOwner(
    keyId: string,
    paymentId: string,
    claimGeneration: number,
    trx: import("knex").Knex.Transaction,
  ): Promise<void> {
    const key = await this.idempotencyRepo.findByIdAndLock(keyId, trx);
    if (
      !key ||
      key.status !== IdempotencyKeyStatus.PROCESSING ||
      key.claim_generation !== claimGeneration
    ) {
      throw new Error("Payment claim is no longer owned by this worker");
    }

    const payment = await this.paymentRepo.findByIdAndLock(paymentId, trx);
    if (
      !payment ||
      ![PaymentStatus.PENDING, PaymentStatus.REQUIRES_RECONCILIATION].includes(
        payment.status as PaymentStatus,
      )
    ) {
      throw new Error("Payment claim is no longer processable");
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
