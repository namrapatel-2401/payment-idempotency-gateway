import { describe, it, expect } from "vitest";
import {
  hashRequestBody,
  deriveProviderIdempotencyKey,
} from "../../src/utils/hash.js";

describe("Hash Utilities", () => {
  describe("hashRequestBody", () => {
    it("should generate same hash for same payload with different key order", () => {
      const payload1 = {
        amount: 100,
        currency: "USD",
        customer_email: "test@example.com",
      };

      const payload2 = {
        customer_email: "test@example.com",
        currency: "USD",
        amount: 100,
      };

      const hash1 = hashRequestBody(payload1);
      const hash2 = hashRequestBody(payload2);

      expect(hash1).toBe(hash2);
    });

    it("should generate different hash for different payloads", () => {
      const payload1 = {
        amount: 100,
        currency: "USD",
        customer_email: "test@example.com",
      };

      const payload2 = {
        amount: 101, // Changed amount
        currency: "USD",
        customer_email: "test@example.com",
      };

      const hash1 = hashRequestBody(payload1);
      const hash2 = hashRequestBody(payload2);

      expect(hash1).not.toBe(hash2);
    });

    it("should handle nested objects deterministically", () => {
      const payload1 = {
        amount: 100,
        metadata: {
          b: 2,
          a: 1,
        },
      };

      const payload2 = {
        metadata: {
          a: 1,
          b: 2,
        },
        amount: 100,
      };

      const hash1 = hashRequestBody(payload1);
      const hash2 = hashRequestBody(payload2);

      expect(hash1).toBe(hash2);
    });
  });

  describe("deriveProviderIdempotencyKey", () => {
    it("should derive deterministic provider key from gateway key", () => {
      const gatewayKey = "client-key-12345";
      const providerKey1 = deriveProviderIdempotencyKey(gatewayKey);
      const providerKey2 = deriveProviderIdempotencyKey(gatewayKey);

      expect(providerKey1).toBe(providerKey2);
      expect(providerKey1).toMatch(/^gateway-[a-f0-9]{8}$/);
    });

    it("should generate different provider keys for different gateway keys", () => {
      const providerKey1 = deriveProviderIdempotencyKey("key-1");
      const providerKey2 = deriveProviderIdempotencyKey("key-2");

      expect(providerKey1).not.toBe(providerKey2);
    });
  });
});
