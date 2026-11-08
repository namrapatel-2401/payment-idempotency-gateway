import type { ApiResult, MetricsSnapshot, PaymentRequest, PaymentResponse } from "./types";

const apiBase = import.meta.env.VITE_API_BASE_URL || "/api";

const request = async <T>(path: string, init?: RequestInit): Promise<ApiResult<T>> => {
  const requestId = `playground-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
      ...(init?.headers || {}),
    },
  });
  const body = (await response.json().catch(() => ({ error: "The API returned an empty response." }))) as T;
  return {
    ok: response.ok,
    status: response.status,
    body,
    requestId,
    at: new Date().toISOString(),
  };
};

export const createPayment = (key: string, payload: PaymentRequest) =>
  request<PaymentResponse | Record<string, unknown>>("/payments", {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify(payload),
  });

export const getPayment = (id: string) => request<PaymentResponse | Record<string, unknown>>(`/payments/${encodeURIComponent(id)}`);

export const getMetrics = () => request<MetricsSnapshot>("/metrics", { headers: {} });

export const getHealth = () => request<{ status: string; database: string; uptime: number }>("/health", { headers: {} });
