import type { Knex } from "knex";
import { PaymentEventType, PaymentResponse } from "../models/payment.js";
import {
  IdempotencyKeyStatus,
  isTerminalState,
  isValidTransition,
  PaymentStatus,
} from "../models/payment-status.js";

export type ProviderObservation = {
  eventId: string;
  chargeId?: string;
  providerIdempotencyKey?: string;
  status: "succeeded" | "failed";
  failureMessage?: string;
  providerRevision?: number | null;
  providerEventAt?: Date | null;
  payloadHash: string;
  payload: Record<string, unknown>;
  source: "webhook" | "response" | "reconciliation";
};
type ObservationResult =
  | { kind: "missing" }
  | { kind: "applied"; payment: PaymentResponse; responseCode: number }
  | { kind: "ignored"; payment: PaymentResponse }
  | { kind: "conflict"; payment: PaymentResponse }
  | { kind: "correlation_conflict" };

const responseForPayment = (payment: any): PaymentResponse => ({
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
  created_at: new Date(payment.created_at || Date.now()).toISOString(),
  updated_at: new Date(payment.updated_at || Date.now()).toISOString(),
});

const isOlderObservation = (current: any, incoming: ProviderObservation) =>
  current.provider_revision !== null &&
  current.provider_revision !== undefined &&
  incoming.providerRevision !== null &&
  incoming.providerRevision !== undefined &&
  incoming.providerRevision < current.provider_revision;

export const applyProviderObservation = async (
  trx: Knex.Transaction,
  observation: ProviderObservation,
): Promise<ObservationResult> => {
  // Resolve each supplied identifier independently. Never let an OR query
  // choose an arbitrary payment when the identifiers disagree.
  const byProviderKey = observation.providerIdempotencyKey
    ? await trx("payments")
        .where({ provider_idempotency_key: observation.providerIdempotencyKey })
        .first()
    : null;
  const byChargeId = observation.chargeId
    ? await trx("payments")
        .where({ provider_id: observation.chargeId })
        .first()
    : null;

  if (byProviderKey && byChargeId && byProviderKey.id !== byChargeId.id) {
    await trx("provider_correlation_conflicts")
      .insert({
        provider_event_id: observation.eventId,
        charge_id: observation.chargeId || null,
        provider_idempotency_key: observation.providerIdempotencyKey || null,
        payload_hash: observation.payloadHash,
        conflict_type: "identifiers_reference_different_payments",
        key_payment_id: byProviderKey.id,
        charge_payment_id: byChargeId.id,
        payload: JSON.stringify(observation.payload),
      })
      .onConflict(["provider_event_id", "payload_hash"])
      .ignore();
    return { kind: "correlation_conflict" };
  }

  const candidate = byProviderKey || byChargeId;

  if (!candidate) return { kind: "missing" };

  // Established lock order: idempotency key -> payment -> payment events.
  const key = await trx("idempotency_keys")
    .where({ id: candidate.idempotency_key_id })
    .forUpdate()
    .first();
  if (!key) throw new Error("Idempotency key not found for payment observation");

  const payment = await trx("payments")
    .where({ id: candidate.id })
    .forUpdate()
    .first();
  if (!payment) return { kind: "missing" };

  if (
    observation.chargeId &&
    payment.provider_id &&
    payment.provider_id !== observation.chargeId
  ) {
    await trx("provider_correlation_conflicts")
      .insert({
        provider_event_id: observation.eventId,
        charge_id: observation.chargeId,
        provider_idempotency_key: observation.providerIdempotencyKey || null,
        payload_hash: observation.payloadHash,
        conflict_type: "charge_id_conflicts_with_payment",
        key_payment_id: payment.id,
        payload: JSON.stringify(observation.payload),
      })
      .onConflict(["provider_event_id", "payload_hash"])
      .ignore();
    return { kind: "correlation_conflict" };
  }

  const targetStatus =
    observation.status === "succeeded"
      ? PaymentStatus.COMPLETED
      : PaymentStatus.FAILED;
  const currentStatus = payment.status as PaymentStatus;

  if (isOlderObservation(payment, observation)) {
    await trx("payment_events").insert({
      payment_id: payment.id,
      event_type: PaymentEventType.WEBHOOK_CONFLICT_IGNORED,
      details: JSON.stringify({
        event_id: observation.eventId,
        incoming_revision: observation.providerRevision,
        current_revision: payment.provider_revision,
        reason: "older_provider_revision",
      }),
    });
    return { kind: "ignored", payment: responseForPayment(payment) };
  }

  if (isTerminalState(currentStatus)) {
    if (currentStatus !== targetStatus) {
      await trx("provider_conflicts")
        .insert({
          payment_id: payment.id,
          idempotency_key_id: key.id,
          provider_event_id: observation.eventId,
          charge_id: observation.chargeId,
          provider_idempotency_key: observation.providerIdempotencyKey,
          payload_hash: observation.payloadHash,
          incoming_status: observation.status,
          incoming_revision: observation.providerRevision,
          current_status: currentStatus,
          payload: JSON.stringify(observation.payload),
        })
        .onConflict(["provider_event_id", "payload_hash"])
        .ignore();

      await trx("payment_events").insert({
        payment_id: payment.id,
        event_type: PaymentEventType.WEBHOOK_CONFLICT_IGNORED,
        details: JSON.stringify({
          event_id: observation.eventId,
          incoming_status: targetStatus,
          current_status: currentStatus,
          incoming_revision: observation.providerRevision,
        }),
      });
      return { kind: "conflict", payment: responseForPayment(payment) };
    }

    return { kind: "ignored", payment: responseForPayment(payment) };
  }

  // The original synchronous provider path creates the payment as PENDING,
  // claims the idempotency key as PROCESSING, and keeps the provider call
  // outside the transaction. A claimed provider result may therefore
  // atomically complete that PENDING payment without inventing a second
  // transaction. Webhooks remain subject to the strict state machine.
  const implicitProviderCompletion =
    observation.source !== "webhook" &&
    key.status === IdempotencyKeyStatus.PROCESSING &&
    currentStatus === PaymentStatus.PENDING;

  if (!implicitProviderCompletion && !isValidTransition(currentStatus, targetStatus)) {
    await trx("payment_events").insert({
      payment_id: payment.id,
      event_type: PaymentEventType.WEBHOOK_CONFLICT_IGNORED,
      details: JSON.stringify({
        event_id: observation.eventId,
        from_status: currentStatus,
        attempted_status: targetStatus,
        reason: "invalid_transition",
      }),
    });
    return { kind: "ignored", payment: responseForPayment(payment) };
  }

  await trx("payments").where({ id: payment.id }).update({
    status: targetStatus,
    provider_id: observation.chargeId || payment.provider_id,
    provider_status: observation.status,
    failure_reason: observation.failureMessage || null,
    provider_revision: observation.providerRevision ?? null,
    provider_event_at: observation.providerEventAt ?? null,
    provider_observation_source: observation.source,
    updated_at: trx.fn.now(),
  });

  await trx("payment_events").insert({
    payment_id: payment.id,
    event_type:
      observation.source === "webhook"
        ? `webhook.payment.${observation.status}`
        : observation.status === "succeeded"
          ? PaymentEventType.COMPLETED
          : PaymentEventType.FAILED,
    details: JSON.stringify({
      event_id: observation.eventId,
      charge_id: observation.chargeId,
      provider_revision: observation.providerRevision,
      source: observation.source,
      failure_message: observation.failureMessage,
    }),
  });

  const updatedPayment = await trx("payments").where({ id: payment.id }).first();
  const responseBody = responseForPayment(updatedPayment);
  const responseCode = observation.status === "succeeded" ? 201 : 502;

  if (
    key.status === IdempotencyKeyStatus.PROCESSING ||
    key.status === IdempotencyKeyStatus.REQUIRES_RECONCILIATION
  ) {
    await trx("idempotency_keys").where({ id: key.id }).update({
      response_code: responseCode,
      response_body: responseBody,
      status:
        observation.status === "succeeded"
          ? IdempotencyKeyStatus.COMPLETED
          : IdempotencyKeyStatus.FAILED,
      locked_at: null,
      updated_at: trx.fn.now(),
    });
  }

  return { kind: "applied", payment: responseBody, responseCode };
};

