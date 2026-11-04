import { getDb } from "../db/connection.js";
import { IdempotencyKeyRepository } from "../db/repositories/idempotency-key.repository.js";
import { PaymentRepository } from "../db/repositories/payment.repository.js";
import { RECOVERY_POLICY } from "../db/recovery-policy.js";
import { IdempotencyKey } from "../models/payment.js";
import { IdempotencyKeyStatus, PaymentStatus } from "../models/payment-status.js";
import { PaymentProviderClient, ProviderChargeResponse } from "./provider.client.js";
import { applyProviderObservation, ProviderObservation } from "./provider-observation.service.js";
import { hashCanonicalJson } from "../utils/canonical-json.js";
import { logger } from "../utils/logger.js";

export type RecoveryWorkerOptions = {
  pollIntervalMs?: number;
  batchSize?: number;
  maxInFlight?: number;
  maxAttempts?: number;
  maxBackoffMs?: number;
  leaseMs?: number;
  random?: () => number;
};

type ClaimedKey = IdempotencyKey & {
  reconciliation_claim_token: string;
  reconciliation_attempts: number;
  reconciliation_locked_at: Date;
};

export const calculateRecoveryDelay = (
  attempt: number,
  random: () => number = Math.random,
  maxBackoffMs = RECOVERY_POLICY.maxBackoffMs,
): number => {
  const exponential = Math.min(maxBackoffMs, 1_000 * 2 ** Math.max(0, attempt - 1));
  return Math.min(maxBackoffMs, Math.round(exponential * (0.75 + random() * 0.25)));
};

const isRetryableError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return ["timeout", "network", "econn", "unavailable", "temporarily", "502", "503", "504"].some((term) => message.includes(term));
};

export class UncertainPaymentRecoveryWorker {
  private readonly idempotencyRepo = new IdempotencyKeyRepository();
  private readonly paymentRepo = new PaymentRepository();
  private readonly providerClient: PaymentProviderClient;
  private readonly options: Required<RecoveryWorkerOptions>;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private pollTask: Promise<void> | null = null;
  private cycleTail: Promise<unknown> = Promise.resolve();
  private active = new Set<Promise<void>>();

  constructor(
    providerClient = new PaymentProviderClient(),
    options: RecoveryWorkerOptions = {},
  ) {
    this.providerClient = providerClient;
    this.options = {
      pollIntervalMs: options.pollIntervalMs ?? RECOVERY_POLICY.pollIntervalMs,
      batchSize: options.batchSize ?? RECOVERY_POLICY.batchSize,
      maxInFlight: options.maxInFlight ?? RECOVERY_POLICY.maxInFlight,
      maxAttempts: options.maxAttempts ?? RECOVERY_POLICY.maxAttempts,
      maxBackoffMs: options.maxBackoffMs ?? RECOVERY_POLICY.maxBackoffMs,
      leaseMs: options.leaseMs ?? RECOVERY_POLICY.leaseMs,
      random: options.random ?? Math.random,
    };
  }

  async runOnce(): Promise<number> {
    // maxInFlight is scoped to this worker process. Serializing cycles makes
    // public runOnce calls and the internal poll loop share the same capacity
    // boundary; separate worker processes require separate capacity budgets.
    const cycle = this.cycleTail.then(() => this.runOnceExclusive());
    this.cycleTail = cycle.catch(() => undefined);
    return cycle;
  }

  private async runOnceExclusive(): Promise<number> {
    const available = this.options.maxInFlight - this.active.size;
    if (available <= 0) return 0;

    // Never claim more work than can start immediately. With a 10 second
    // provider timeout and a 60 second lease, this prevents a claimed batch
    // from waiting behind queued operations until its lease expires.
    const claimLimit = Math.min(this.options.batchSize, available);
    const claims = await getDb().transaction((trx) =>
      this.idempotencyRepo.claimReconciliationBatch({
        batchSize: claimLimit,
        leaseMs: this.options.leaseMs,
      }, trx),
    ) as ClaimedKey[];

    const work = claims.map((claim) => this.processClaim(claim));
    await Promise.all(work);
    return claims.length;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pollTask = this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pollTask) {
      await this.pollTask;
      this.pollTask = null;
    }
    await this.cycleTail;
    await Promise.all([...this.active]);
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    try {
      await this.runOnce();
    } catch (error) {
      logger.error({ error }, "Uncertain payment recovery poll failed");
    }
    if (this.running) {
      this.timer = setTimeout(() => void this.poll(), this.options.pollIntervalMs);
    }
  }

  private async processClaim(claim: ClaimedKey): Promise<void> {
    const operation = this.processClaimOwned(claim)
      .catch((error) => this.handleFailure(claim, error))
      .finally(() => this.active.delete(operation));
    this.active.add(operation);
    await operation;
  }

  private async processClaimOwned(claim: ClaimedKey): Promise<void> {
    const payment = await getDb().transaction(async (trx) => {
      const key = await this.idempotencyRepo.findByIdAndLock(claim.id, trx);
      if (!this.ownsClaim(key, claim)) throw new Error("Recovery claim is no longer owned");
      const currentPayment = await this.paymentRepo.findByIdAndLockByKey(claim.id, trx);
      if (!currentPayment) throw new Error("Payment record not found for recovery claim");
      return currentPayment;
    });

    let providerCharge: ProviderChargeResponse | null;
    try {
      providerCharge = await this.providerClient.getChargeByIdempotencyKey(payment.provider_idempotency_key);
    } catch (error) {
      await this.handleFailure(claim, error);
      return;
    }

    if (!providerCharge) {
      try {
        providerCharge = await this.providerClient.createCharge(payment.provider_idempotency_key, {
          amount: Number(payment.amount),
          currency: payment.currency,
          customer_email: payment.customer_email,
          description: payment.description ?? undefined,
          metadata: payment.metadata,
        });
      } catch (error) {
        await this.handleFailure(claim, error);
        return;
      }
    }

    await getDb().transaction(async (trx) => {
      const key = await this.idempotencyRepo.findByIdAndLock(claim.id, trx);
      if (!this.ownsClaim(key, claim)) throw new Error("Recovery claim was fenced before persistence");
      const currentPayment = await this.paymentRepo.findByIdAndLockByKey(claim.id, trx);
      if (!currentPayment) throw new Error("Payment record disappeared during recovery");

      const observation: ProviderObservation = {
        eventId: `recovery:${claim.id}:${claim.claim_generation}:${providerCharge.id}`,
        chargeId: providerCharge.id,
        providerIdempotencyKey: currentPayment.provider_idempotency_key,
        status: providerCharge.status,
        failureMessage: providerCharge.failure_message,
        providerRevision: providerCharge.provider_revision ?? null,
        providerEventAt: new Date(),
        payloadHash: hashCanonicalJson(providerCharge),
        payload: providerCharge as unknown as Record<string, unknown>,
        source: "reconciliation",
      };
      const result = await applyProviderObservation(trx, observation);
      if (result.kind === "correlation_conflict") {
        await this.releaseWithinTransaction(trx, claim, "Provider identifier correlation conflict");
        return;
      }
      if (result.kind === "missing") {
        await this.releaseWithinTransaction(trx, claim, "Provider observation could not be correlated");
        return;
      }

      const finalStatus = result.payment.status === PaymentStatus.COMPLETED
        ? IdempotencyKeyStatus.COMPLETED
        : result.payment.status === PaymentStatus.FAILED
          ? IdempotencyKeyStatus.FAILED
          : null;
      if (finalStatus) {
        await trx("idempotency_keys")
          .where({ id: claim.id, claim_generation: claim.claim_generation, reconciliation_claim_token: claim.reconciliation_claim_token })
          .whereIn("status", [IdempotencyKeyStatus.COMPLETED, IdempotencyKeyStatus.FAILED])
          .update({
            reconciliation_status: "resolved",
            reconciliation_claim_token: null,
            reconciliation_locked_at: null,
            reconciliation_resolved_at: trx.fn.now(),
            reconciliation_last_error: null,
          });
      }
    });
  }

  private async handleFailure(claim: ClaimedKey, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const manualReview = claim.reconciliation_attempts >= this.options.maxAttempts || !isRetryableError(error);
    const nextAt = manualReview ? null : new Date(Date.now() + calculateRecoveryDelay(claim.reconciliation_attempts, this.options.random, this.options.maxBackoffMs));
    await getDb().transaction((trx) => this.idempotencyRepo.releaseReconciliation(claim.id, claim.reconciliation_claim_token, {
      nextAt,
      error: message,
      manualReview,
    }, trx));
  }

  private async releaseWithinTransaction(trx: import("knex").Knex.Transaction, claim: ClaimedKey, error: string): Promise<void> {
    const manualReview = claim.reconciliation_attempts >= this.options.maxAttempts;
    await this.idempotencyRepo.releaseReconciliation(claim.id, claim.reconciliation_claim_token, {
      nextAt: manualReview ? null : new Date(Date.now() + calculateRecoveryDelay(claim.reconciliation_attempts, this.options.random, this.options.maxBackoffMs)),
      error,
      manualReview,
    }, trx);
  }

  private ownsClaim(key: IdempotencyKey | null, claim: ClaimedKey): boolean {
    return Boolean(
      key &&
      key.status === IdempotencyKeyStatus.PROCESSING &&
      key.claim_generation === claim.claim_generation &&
      key.reconciliation_claim_token === claim.reconciliation_claim_token,
    );
  }
}
