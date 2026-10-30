import { describe, it, expect } from "vitest";
import {
  createPaymentSchema,
  paymentResponseSchema,
} from "../../src/models/payment.js";

describe("Payment Schemas", () => {
  describe("createPaymentSchema", () => {
    it("should validate a valid payment request", () => {
      const validRequest = {
        amount: 99.99,
        currency: "USD",
        customer_email: "test@example.com",
        description: "Test payment",
        metadata: { order_id: "12345" },
      };

      const result = createPaymentSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    it("should reject negative amount", () => {
      const invalidRequest = {
        amount: -10,
        currency: "USD",
        customer_email: "test@example.com",
      };

      const result = createPaymentSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it("should reject zero amount", () => {
      const invalidRequest = {
        amount: 0,
        currency: "USD",
        customer_email: "test@example.com",
      };

      const result = createPaymentSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it("should reject invalid email", () => {
      const invalidRequest = {
        amount: 50.0,
        currency: "USD",
        customer_email: "not-an-email",
      };

      const result = createPaymentSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it("should reject invalid currency (not 3 chars)", () => {
      const invalidRequest = {
        amount: 50.0,
        currency: "US",
        customer_email: "test@example.com",
      };

      const result = createPaymentSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it("should convert currency to uppercase", () => {
      const request = {
        amount: 50.0,
        currency: "usd",
        customer_email: "test@example.com",
      };

      const result = createPaymentSchema.parse(request);
      expect(result.currency).toBe("USD");
    });

    it("should accept missing optional fields", () => {
      const minimalRequest = {
        amount: 50.0,
        currency: "USD",
        customer_email: "test@example.com",
      };

      const result = createPaymentSchema.safeParse(minimalRequest);
      expect(result.success).toBe(true);
    });

    it("should reject description longer than 500 chars", () => {
      const invalidRequest = {
        amount: 50.0,
        currency: "USD",
        customer_email: "test@example.com",
        description: "x".repeat(501),
      };

      const result = createPaymentSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });
  });

  describe("paymentResponseSchema", () => {
    it("should validate a complete payment response", () => {
      const validResponse = {
        id: "123e4567-e89b-12d3-a456-426614174000",
        amount: 99.99,
        currency: "USD",
        customer_email: "test@example.com",
        description: "Test payment",
        status: "completed",
        provider_id: "ch_123456",
        provider_status: "succeeded",
        failure_reason: null,
        metadata: { order_id: "12345" },
        created_at: "2026-09-16T16:00:00.000Z",
        updated_at: "2026-09-16T16:01:00.000Z",
      };

      const result = paymentResponseSchema.safeParse(validResponse);
      expect(result.success).toBe(true);
    });

    it("should reject invalid UUID", () => {
      const invalidResponse = {
        id: "not-a-uuid",
        amount: 99.99,
        currency: "USD",
        customer_email: "test@example.com",
        description: null,
        status: "completed",
        provider_id: null,
        provider_status: null,
        failure_reason: null,
        metadata: {},
        created_at: "2026-09-16T16:00:00.000Z",
        updated_at: "2026-09-16T16:01:00.000Z",
      };

      const result = paymentResponseSchema.safeParse(invalidResponse);
      expect(result.success).toBe(false);
    });

    it("should reject invalid status", () => {
      const invalidResponse = {
        id: "123e4567-e89b-12d3-a456-426614174000",
        amount: 99.99,
        currency: "USD",
        customer_email: "test@example.com",
        description: null,
        status: "invalid_status",
        provider_id: null,
        provider_status: null,
        failure_reason: null,
        metadata: {},
        created_at: "2026-09-16T16:00:00.000Z",
        updated_at: "2026-09-16T16:01:00.000Z",
      };

      const result = paymentResponseSchema.safeParse(invalidResponse);
      expect(result.success).toBe(false);
    });
  });
});
