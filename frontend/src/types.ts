export type PaymentStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "requires_reconciliation";

export type PaymentResponse = {
  id: string;
  amount: number;
  currency: string;
  customer_email: string;
  description: string | null;
  status: PaymentStatus;
  provider_id: string | null;
  provider_status: string | null;
  failure_reason: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type PaymentRequest = {
  amount: number;
  currency: string;
  customer_email: string;
  description?: string;
  metadata?: Record<string, unknown>;
};

export type ApiResult<T> = {
  ok: boolean;
  status: number;
  body: T;
  requestId: string;
  at: string;
};

export type MetricsSnapshot = {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  generated_at: string;
};
