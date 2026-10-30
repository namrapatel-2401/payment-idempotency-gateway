import { config } from "../config.js";

export interface ProviderChargeRequest {
  amount: number;
  currency: string;
  customer_email: string;
  description?: string;
  metadata?: Record<string, any>;
}

export interface ProviderChargeResponse {
  id: string;
  status: "succeeded" | "failed";
  amount: number;
  currency: string;
  failure_message?: string;
}

export class PaymentProviderClient {
  private baseUrl: string;
  private timeout: number;

  constructor() {
    this.baseUrl = config.provider.baseUrl;
    this.timeout = config.provider.timeoutMs;
  }

  /**
   * Create a charge with the provider
   * @param idempotencyKey Provider-scoped idempotency key
   * @param request Charge request
   */
  async createCharge(
    idempotencyKey: string,
    request: ProviderChargeRequest,
  ): Promise<ProviderChargeResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/provider/charge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = (await response.json()) as any;

      if (!response.ok) {
        throw new Error(data.error || `Provider error: ${response.status}`);
      }

      return data;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Provider request timeout");
      }

      throw error;
    }
  }

  /**
   * Query charge status by provider idempotency key (for reconciliation)
   * @param idempotencyKey Provider-scoped idempotency key
   */
  async getChargeByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<ProviderChargeResponse | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(
        `${this.baseUrl}/provider/charge/by-idempotency-key/${encodeURIComponent(idempotencyKey)}`,
        {
          method: "GET",
          signal: controller.signal,
        },
      );

      clearTimeout(timeoutId);

      if (response.status === 404) {
        return null; // Provider has no record of this key
      }

      const data = (await response.json()) as any;

      if (!response.ok) {
        throw new Error(data.error || `Provider error: ${response.status}`);
      }

      return data;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Provider request timeout");
      }

      throw error;
    }
  }
}
