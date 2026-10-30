import { getDb } from "../connection.js";
import {
  Payment,
  PaymentEvent,
  PaymentEventType,
} from "../../models/payment.js";
import { PaymentStatus } from "../../models/payment-status.js";

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
  }): Promise<Payment> {
    const [payment] = await getDb()("payments")
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
  async findById(id: string): Promise<Payment | null> {
    const payment = await getDb()("payments").where({ id }).first();

    return payment || null;
  }

  /**
   * Find payment by idempotency key ID
   */
  async findByIdempotencyKeyId(
    idempotencyKeyId: string,
  ): Promise<Payment | null> {
    const payment = await getDb()("payments")
      .where({ idempotency_key_id: idempotencyKeyId })
      .first();

    return payment || null;
  }

  /**
   * Find payment by provider idempotency key
   */
  async findByProviderIdempotencyKey(
    providerKey: string,
  ): Promise<Payment | null> {
    const payment = await getDb()("payments")
      .where({ provider_idempotency_key: providerKey })
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
      provider_id?: string;
      provider_status?: string;
      failure_reason?: string;
    },
  ): Promise<void> {
    await getDb()("payments").where({ id }).update({
      status,
      provider_id: providerDetails?.provider_id,
      provider_status: providerDetails?.provider_status,
      failure_reason: providerDetails?.failure_reason,
      updated_at: getDb().fn.now(),
    });
  }

  /**
   * Create payment event (audit log entry)
   */
  async createEvent(data: {
    payment_id: string;
    event_type: PaymentEventType;
    details?: Record<string, any>;
  }): Promise<PaymentEvent> {
    const [event] = await getDb()("payment_events")
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
  async getEventsByPaymentId(paymentId: string): Promise<PaymentEvent[]> {
    const events = await getDb()("payment_events")
      .where({ payment_id: paymentId })
      .orderBy("created_at", "asc")
      .select("*");

    return events;
  }
}
