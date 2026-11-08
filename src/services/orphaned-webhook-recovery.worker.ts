import { getDb } from "../db/connection.js";
import { OrphanedWebhookRepository } from "../db/repositories/orphaned-webhook.repository.js";
import { IdempotencyKeyRepository } from "../db/repositories/idempotency-key.repository.js";
import { PaymentRepository } from "../db/repositories/payment.repository.js";
import { RECOVERY_POLICY } from "../db/recovery-policy.js";
import { applyProviderObservation, ProviderObservation } from "./provider-observation.service.js";
import { calculateRecoveryDelay } from "./uncertain-payment-recovery.worker.js";
import { logger } from "../utils/logger.js";
import { hashCanonicalJson } from "../utils/canonical-json.js";
import {
  logOperationalEvent,
  recordRecoveryClaim,
  recordRecoveryOutcome,
  recordRecoveryPoll,
  setRecoveryInFlight,
} from "../observability/metrics.js";

type OrphanClaim = {
  id: string;
  webhook_id: string;
  charge_id: string | null;
  provider_idempotency_key: string | null;
  payload: Record<string, unknown>;
  payload_hash: string | null;
  recovery_claim_token: string;
  recovery_attempts: number;
};

export type OrphanRecoveryWorkerOptions = {
  pollIntervalMs?: number;
  batchSize?: number;
  maxInFlight?: number;
  maxAttempts?: number;
  maxBackoffMs?: number;
  leaseMs?: number;
  random?: () => number;
};

export class OrphanedWebhookRecoveryWorker {
  private readonly orphanRepo = new OrphanedWebhookRepository();
  private readonly idempotencyRepo = new IdempotencyKeyRepository();
  private readonly paymentRepo = new PaymentRepository();
  private readonly options: Required<OrphanRecoveryWorkerOptions>;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private pollTask: Promise<void> | null = null;
  private cycleTail: Promise<unknown> = Promise.resolve();
  private active = new Set<Promise<void>>();

  constructor(options: OrphanRecoveryWorkerOptions = {}) {
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
    const claims = await getDb().transaction((trx) => this.orphanRepo.claimBatch({
      batchSize: Math.min(this.options.batchSize, available),
      leaseMs: this.options.leaseMs,
    }, trx)) as OrphanClaim[];
    recordRecoveryClaim("orphaned_webhook", claims.length);
    logOperationalEvent("recovery.claimed", { workflow: "orphaned_webhook", count: claims.length });
    await Promise.all(claims.map((claim) => this.processClaim(claim)));
    recordRecoveryPoll("orphaned_webhook", "completed");
    return claims.length;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    logOperationalEvent("recovery.worker_started", { workflow: "orphaned_webhook" });
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
    logOperationalEvent("recovery.worker_stopped", { workflow: "orphaned_webhook" });
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    try {
      await this.runOnce();
    } catch (error) {
      recordRecoveryPoll("orphaned_webhook", "failed");
      logger.error({ error }, "Orphan webhook recovery poll failed");
    }
    if (this.running) this.timer = setTimeout(() => void this.poll(), this.options.pollIntervalMs);
  }

  private async processClaim(claim: OrphanClaim): Promise<void> {
    const operation = this.processClaimOwned(claim)
      .catch((error) => this.releaseAfterFailure(claim, error))
      .finally(() => {
        this.active.delete(operation);
        setRecoveryInFlight("orphaned_webhook", this.active.size);
      });
    this.active.add(operation);
    setRecoveryInFlight("orphaned_webhook", this.active.size);
    await operation;
  }

  private async processClaimOwned(claim: OrphanClaim): Promise<void> {
    await getDb().transaction(async (trx) => {
      const orphan = await trx("orphaned_webhooks")
        .where({ id: claim.id, recovery_claim_token: claim.recovery_claim_token, recovery_status: "processing", resolved: false })
        .forUpdate()
        .first();
      if (!orphan) throw new Error("Orphan recovery claim is no longer owned");
    });

    const payload = claim.payload as any;
    const observation: ProviderObservation = {
      eventId: claim.webhook_id,
      chargeId: claim.charge_id || payload.charge_id,
      providerIdempotencyKey: claim.provider_idempotency_key || payload.idempotency_key,
      status: payload.status,
      failureMessage: payload.failure_message,
      providerRevision: payload.provider_revision ?? 1,
      providerEventAt: payload.timestamp ? new Date(payload.timestamp) : null,
      payloadHash: claim.payload_hash || hashCanonicalJson(payload),
      payload,
      source: "webhook",
    };

    await getDb().transaction(async (trx) => {
      const byProviderKey = observation.providerIdempotencyKey
        ? await trx("payments").where({ provider_idempotency_key: observation.providerIdempotencyKey }).first()
        : null;
      const byChargeId = observation.chargeId
        ? await trx("payments").where({ provider_id: observation.chargeId }).first()
        : null;
      const orphanLock = () => trx("orphaned_webhooks")
        .where({ id: claim.id, recovery_claim_token: claim.recovery_claim_token, recovery_status: "processing", resolved: false })
        .forUpdate()
        .first();

      if (byProviderKey && byChargeId && byProviderKey.id !== byChargeId.id) {
        await trx("provider_correlation_conflicts").insert({
          provider_event_id: observation.eventId,
          charge_id: observation.chargeId || null,
          provider_idempotency_key: observation.providerIdempotencyKey || null,
          payload_hash: observation.payloadHash,
          conflict_type: "identifiers_reference_different_payments",
          key_payment_id: byProviderKey.id,
          charge_payment_id: byChargeId.id,
          payload: JSON.stringify(observation.payload),
        }).onConflict(["provider_event_id", "payload_hash"]).ignore();
        const orphan = await orphanLock();
        if (orphan) await this.releaseWithinTransaction(trx, claim, "Webhook identifiers reference different payments");
        return;
      }

      const candidate = byProviderKey || byChargeId;
      if (!candidate) {
        const orphan = await orphanLock();
        if (orphan) await this.releaseWithinTransaction(trx, claim, "Webhook payment is still unidentifiable");
        return;
      }

      // Final business application order: idempotency key -> payment -> orphan -> payment events.
      const key = await this.idempotencyRepo.findByIdAndLock(candidate.idempotency_key_id, trx);
      const payment = await this.paymentRepo.findByIdAndLock(candidate.id, trx);
      const orphan = await orphanLock();
      if (!key || !payment || !orphan) return;

      const existingEvent = await trx("payment_events")
        .where({ payment_id: payment.id })
        .whereRaw("details->>'event_id' = ?", [observation.eventId])
        .first();
      if (existingEvent) {
        const resolved = await this.orphanRepo.markResolved(claim.id, claim.recovery_claim_token, "already_applied", trx);
        if (resolved) recordRecoveryOutcome("orphaned_webhook", "resolved");
        return;
      }

      const applied = await applyProviderObservation(trx, observation);
      if (applied.kind === "missing") {
        await this.releaseWithinTransaction(trx, claim, "Webhook payment is still unidentifiable");
      } else if (applied.kind === "correlation_conflict") {
        await this.releaseWithinTransaction(trx, claim, "Webhook provider identifiers conflict");
      } else if (applied.kind === "conflict") {
        const resolved = await this.orphanRepo.markResolved(claim.id, claim.recovery_claim_token, "terminal_conflict_preserved", trx);
        if (resolved) recordRecoveryOutcome("orphaned_webhook", "resolved");
      } else if (applied.kind === "ignored") {
        const resolved = await this.orphanRepo.markResolved(claim.id, claim.recovery_claim_token, "ignored_older_observation", trx);
        if (resolved) recordRecoveryOutcome("orphaned_webhook", "resolved");
      } else {
        const resolved = await this.orphanRepo.markResolved(claim.id, claim.recovery_claim_token, "applied", trx);
        if (resolved) recordRecoveryOutcome("orphaned_webhook", "resolved");
      }
    });
  }

  private async releaseAfterFailure(claim: OrphanClaim, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const manualReview = claim.recovery_attempts >= this.options.maxAttempts;
    const nextAt = manualReview ? null : new Date(Date.now() + calculateRecoveryDelay(claim.recovery_attempts, this.options.random, this.options.maxBackoffMs));
    const released = await getDb().transaction((trx) => this.orphanRepo.release(claim.id, claim.recovery_claim_token, { nextAt, error: message, manualReview }, trx));
    recordRecoveryOutcome("orphaned_webhook", released ? (manualReview ? "manual_review" : "retrying") : "stale");
  }

  private async releaseWithinTransaction(trx: import("knex").Knex.Transaction, claim: OrphanClaim, error: string): Promise<void> {
    const manualReview = claim.recovery_attempts >= this.options.maxAttempts;
    const released = await this.orphanRepo.release(claim.id, claim.recovery_claim_token, {
      nextAt: manualReview ? null : new Date(Date.now() + calculateRecoveryDelay(claim.recovery_attempts, this.options.random, this.options.maxBackoffMs)),
      error,
      manualReview,
    }, trx);
    if (released) recordRecoveryOutcome("orphaned_webhook", manualReview ? "manual_review" : "retrying");
  }
}
