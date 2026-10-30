import { z } from "zod";

// Payment request schema
export const createPaymentSchema = z.object({
  amount: z.number().positive().finite(),
  currency: z.string().length(3).toUpperCase(),
  customer_email: z.string().email(),
  description: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export type CreatePaymentRequest = z.infer<typeof createPaymentSchema>;

// Payment response schema
export const paymentResponseSchema = z.object({
  id: z.string().uuid(),
  amount: z.number(),
  currency: z.string(),
  customer_email: z.string(),
  description: z.string().nullable(),
  status: z.enum([
    "pending",
    "processing",
    "completed",
    "failed",
    "requires_reconciliation",
  ]),
  provider_id: z.string().nullable(),
  provider_status: z.string().nullable(),
  failure_reason: z.string().nullable(),
  metadata: z.record(z.string(), z.any()),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type PaymentResponse = z.infer<typeof paymentResponseSchema>;

// Idempotency key model
export interface IdempotencyKey {
  id: string;
  key: string;
  request_path: string;
  request_hash: string;
  status: string;
  response_code: number | null;
  response_body: any | null;
  locked_at: Date | null;
  claim_generation: number;
  reconciliation_status?: string | null;
  reconciliation_attempts?: number;
  next_reconciliation_at?: Date | null;
  reconciliation_claim_token?: string | null;
  reconciliation_locked_at?: Date | null;
  reconciliation_last_error?: string | null;
  reconciliation_manual_review_at?: Date | null;
  reconciliation_resolved_at?: Date | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
}

// Payment model
export interface Payment {
  id: string;
  idempotency_key_id: string;
  provider_idempotency_key: string;
  amount: string;
  currency: string;
  customer_email: string;
  description: string | null;
  status: string;
  provider_id: string | null;
  provider_status: string | null;
  provider_revision: number | null;
  provider_event_at: Date | null;
  provider_observation_source: string | null;
  failure_reason: string | null;
  metadata: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

// Payment event model (audit log)
export interface PaymentEvent {
  id: string;
  payment_id: string;
  event_type: string;
  details: Record<string, any>;
  created_at: Date;
}

// Event types
export enum PaymentEventType {
  CREATED = "payment.created",
  PROCESSING = "payment.processing",
  COMPLETED = "payment.completed",
  FAILED = "payment.failed",
  REQUIRES_RECONCILIATION = "payment.requires_reconciliation",
  RECONCILED = "payment.reconciled",
  WEBHOOK_CONFLICT = "webhook.provider_conflict",
  WEBHOOK_CONFLICT_IGNORED = "webhook.conflict_ignored",
}
