import { getDb } from "../connection.js";
import {
  Payment,
  PaymentEvent,
  PaymentEventType,
} from "../../models/payment.js";
import { PaymentStatus } from "../../models/payment-status.js";
import type { DbExecutor } from "./idempotency-key.repository.js";

export class PaymentRepository {
  /**
   * Create a new payment record
   */
  async create(data: {
    idempotency_key_id: string;
    provider_idempotency_key: string;
    amount: number;
    currency: string;
    customer_email: string;
    description?: string;
    metadata?: Record<string, any>;
  }, db: DbExecutor = getDb()): Promise<Payment> {
    const [payment] = await db("payments")
      .insert({
        idempotency_key_id: data.idempotency_key_id,
        provider_idempotency_key: data.provider_idempotency_key,
        amount: data.amount.toFixed(2),
        currency: data.currency,
        customer_email: data.customer_email,
        description: data.description || null,
        status: PaymentStatus.PENDING,
        metadata: JSON.stringify(data.metadata || {}),
      })
      .returning("*");

    return payment;
  }

  /**
   * Find payment by ID
   */
  async findById(
    id: string,
    db: DbExecutor = getDb(),
  ): Promise<Payment | null> {
    const payment = await db("payments").where({ id }).first();

    return payment || null;
  }

  /**
   * Find payment by idempotency key ID
   */
  async findByIdempotencyKeyId(
    idempotencyKeyId: string,
    db: DbExecutor = getDb(),
  ): Promise<Payment | null> {
    const payment = await db("payments")
      .where({ idempotency_key_id: idempotencyKeyId })
      .first();

    return payment || null;
  }

  /**
   * Find a payment by idempotency key ID while holding its row lock.
   */
  async findByIdempotencyKeyIdAndLock(
    idempotencyKeyId: string,
    db: DbExecutor = getDb(),
  ): Promise<Payment | null> {
    const payment = await db("payments")
      .where({ idempotency_key_id: idempotencyKeyId })
      .forUpdate()
      .first();

    return payment || null;
  }

  /**
   * Find payment by provider idempotency key
   */
  async findByProviderIdempotencyKey(
    providerKey: string,
    db: DbExecutor = getDb(),
  ): Promise<Payment | null> {
    const payment = await db("payments")
      .where({ provider_idempotency_key: providerKey })
      .first();

    return payment || null;
  }

  /**
   * Find a payment by ID while holding its row lock.
   */
  async findByIdAndLock(
    id: string,
    db: DbExecutor = getDb(),
  ): Promise<Payment | null> {
    const payment = await db("payments")
      .where({ id })
      .forUpdate()
      .first();

    return payment || null;
  }

  /**
   * Update payment status and provider details
   */
  async updateStatus(
    id: string,
    status: PaymentStatus,
    providerDetails?: {
      provider_id?: string | null;
      provider_status?: string | null;
      failure_reason?: string | null;
      provider_revision?: number | null;
      provider_event_at?: Date | null;
      provider_observation_source?: string | null;
    },
    db: DbExecutor = getDb(),
  ): Promise<void> {
    const updates: Record<string, unknown> = {
      status,
      ...(providerDetails?.provider_revision === undefined
        ? {}
        : { provider_revision: providerDetails.provider_revision }),
      ...(providerDetails?.provider_event_at === undefined
        ? {}
        : { provider_event_at: providerDetails.provider_event_at }),
      ...(providerDetails?.provider_observation_source === undefined
        ? {}
        : { provider_observation_source: providerDetails.provider_observation_source }),
      updated_at: db.fn.now(),
    };

    for (const field of ["provider_id", "provider_status", "failure_reason"] as const) {
      if (providerDetails && Object.prototype.hasOwnProperty.call(providerDetails, field)) {
        updates[field] = providerDetails[field];
      }
    }

    await db("payments").where({ id }).update(updates);
  }

  /**
   * Create payment event (audit log entry)
   */
  async createEvent(data: {
    payment_id: string;
    event_type: PaymentEventType;
    details?: Record<string, any>;
  }, db: DbExecutor = getDb()): Promise<PaymentEvent> {
    const [event] = await db("payment_events")
      .insert({
        payment_id: data.payment_id,
        event_type: data.event_type,
        details: JSON.stringify(data.details || {}),
      })
      .returning("*");

    return event;
  }

  /**
   * Get all events for a payment (audit trail)
   */
  async getEventsByPaymentId(
    paymentId: string,
    db: DbExecutor = getDb(),
  ): Promise<PaymentEvent[]> {
    const events = await db("payment_events")
      .where({ payment_id: paymentId })
      .orderBy("created_at", "asc")
      .select("*");

    return events;
  }
}
