import { getDb } from "../db/connection.js";
import { ProviderConflictRepository } from "../db/repositories/provider-conflict.repository.js";
import { IdempotencyKeyRepository } from "../db/repositories/idempotency-key.repository.js";
import { PaymentRepository } from "../db/repositories/payment.repository.js";
import { RECOVERY_POLICY } from "../db/recovery-policy.js";
import { PaymentEventType } from "../models/payment.js";
import { PaymentStatus } from "../models/payment-status.js";
import { PaymentProviderClient, ProviderChargeResponse } from "./provider.client.js";
import { calculateRecoveryDelay } from "./uncertain-payment-recovery.worker.js";
import { logger } from "../utils/logger.js";

type ConflictClaim = {
  id: string;
  payment_id: string;
  idempotency_key_id: string;
  resolution_claim_token: string;
  resolution_attempts: number;
};

export type ProviderConflictWorkerOptions = {
  pollIntervalMs?: number;
  batchSize?: number;
  maxInFlight?: number;
  maxAttempts?: number;
  maxBackoffMs?: number;
  leaseMs?: number;
  random?: () => number;
};

const isRetryableError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return ["timeout", "network", "econn", "unavailable", "temporarily", "502", "503", "504"].some((term) => message.includes(term));
};

export class ProviderConflictResolutionWorker {
  private readonly conflictRepo = new ProviderConflictRepository();
  private readonly idempotencyRepo = new IdempotencyKeyRepository();
  private readonly paymentRepo = new PaymentRepository();
  private readonly providerClient: PaymentProviderClient;
  private readonly options: Required<ProviderConflictWorkerOptions>;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private pollTask: Promise<void> | null = null;
  private cycleTail: Promise<unknown> = Promise.resolve();
  private active = new Set<Promise<void>>();

  constructor(providerClient = new PaymentProviderClient(), options: ProviderConflictWorkerOptions = {}) {
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
    const cycle = this.cycleTail.then(() => this.runOnceExclusive());
    this.cycleTail = cycle.catch(() => undefined);
    return cycle;
  }

  private async runOnceExclusive(): Promise<number> {
    const available = this.options.maxInFlight - this.active.size;
    if (available <= 0) return 0;
    const claims = await getDb().transaction((trx) => this.conflictRepo.claimBatch({
      batchSize: Math.min(this.options.batchSize, available),
      leaseMs: this.options.leaseMs,
    }, trx)) as ConflictClaim[];
    await Promise.all(claims.map((claim) => this.processClaim(claim)));
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
      logger.error({ error }, "Provider conflict resolution poll failed");
    }
    if (this.running) this.timer = setTimeout(() => void this.poll(), this.options.pollIntervalMs);
  }

  private async processClaim(claim: ConflictClaim): Promise<void> {
    const operation = this.processClaimOwned(claim)
      .catch((error) => this.releaseAfterFailure(claim, error))
      .finally(() => {
        this.active.delete(operation);
      });
    this.active.add(operation);
    await operation;
  }

  private async processClaimOwned(claim: ConflictClaim): Promise<void> {
    await getDb().transaction(async (trx) => {
      const key = await this.idempotencyRepo.findByIdAndLock(claim.idempotency_key_id, trx);
      const payment = await this.paymentRepo.findByIdAndLock(claim.payment_id, trx);
      const conflict = await trx("provider_conflicts")
        .where({ id: claim.id, resolution_claim_token: claim.resolution_claim_token, status: "resolving" })
        .forUpdate()
        .first();
      if (!key || !payment || !conflict) throw new Error("Provider conflict claim is no longer owned");
    });

    let providerCharge: ProviderChargeResponse | null;
    try {
      const payment = await this.paymentRepo.findById(claim.payment_id);
      if (!payment) throw new Error("Payment record not found for conflict resolution");
      providerCharge = await this.providerClient.getChargeByIdempotencyKey(payment.provider_idempotency_key);
    } catch (error) {
      await this.releaseAfterFailure(claim, error);
      return;
    }

    await getDb().transaction(async (trx) => {
      const key = await this.idempotencyRepo.findByIdAndLock(claim.idempotency_key_id, trx);
      const payment = await this.paymentRepo.findByIdAndLock(claim.payment_id, trx);
      const conflict = await trx("provider_conflicts")
        .where({ id: claim.id, resolution_claim_token: claim.resolution_claim_token, status: "resolving" })
        .forUpdate()
        .first();
      if (!key || !payment || !conflict) return;

      if (!providerCharge) {
        await this.releaseWithinTransaction(trx, claim, "Provider lookup returned no charge");
        return;
      }

      const knownRevisions = [conflict.incoming_revision, payment.provider_revision]
        .filter((revision): revision is number => revision !== null && revision !== undefined);
      if (providerCharge.provider_revision !== undefined && providerCharge.provider_revision !== null && knownRevisions.some((revision) => providerCharge!.provider_revision! < revision)) {
        await this.releaseWithinTransaction(trx, claim, "Provider lookup revision is older than known state");
        return;
      }

      const currentStatus = payment.status as PaymentStatus;
      if (![PaymentStatus.COMPLETED, PaymentStatus.FAILED].includes(currentStatus)) {
        await this.releaseWithinTransaction(trx, claim, "Conflict payment is no longer terminal");
        return;
      }

      const providerStatus = providerCharge.status === "succeeded" ? PaymentStatus.COMPLETED : PaymentStatus.FAILED;
      const resolution = providerStatus === currentStatus ? "PROVIDER_CONFIRMED" : "TERMINAL_STATE_PRESERVED";
      const existingAudit = await trx("payment_events")
        .where({ payment_id: payment.id, event_type: PaymentEventType.WEBHOOK_CONFLICT_IGNORED })
        .whereRaw("details->>'conflict_id' = ?", [conflict.id])
        .first();
      if (!existingAudit) {
        await trx("payment_events").insert({
          payment_id: payment.id,
          event_type: PaymentEventType.WEBHOOK_CONFLICT_IGNORED,
          details: JSON.stringify({
            conflict_id: conflict.id,
            resolution,
            provider_status: providerCharge.status,
            provider_revision: providerCharge.provider_revision ?? null,
            incoming_revision: conflict.incoming_revision,
          }),
        });
      }
      const resolved = await this.conflictRepo.markResolved(conflict.id, claim.resolution_claim_token, resolution, trx);
    });
  }

  private async releaseAfterFailure(claim: ConflictClaim, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const manualReview = claim.resolution_attempts >= this.options.maxAttempts || !isRetryableError(error);
    const nextAt = manualReview ? null : new Date(Date.now() + calculateRecoveryDelay(claim.resolution_attempts, this.options.random, this.options.maxBackoffMs));
    const released = await getDb().transaction((trx) => this.conflictRepo.release(claim.id, claim.resolution_claim_token, { nextAt, error: message, manualReview }, trx));
  }

  private async releaseWithinTransaction(trx: import("knex").Knex.Transaction, claim: ConflictClaim, error: string): Promise<void> {
    const manualReview = claim.resolution_attempts >= this.options.maxAttempts;
    const released = await this.conflictRepo.release(claim.id, claim.resolution_claim_token, {
      nextAt: manualReview ? null : new Date(Date.now() + calculateRecoveryDelay(claim.resolution_attempts, this.options.random, this.options.maxBackoffMs)),
      error,
      manualReview,
    }, trx);
  }
}
