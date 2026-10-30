import { describe, it, expect } from "vitest";
import {
  PaymentStatus,
  isValidTransition,
  isTerminalState,
  getValidNextStates,
} from "../../src/models/payment-status.js";

describe("Payment State Machine", () => {
  describe("isValidTransition", () => {
    it("should allow PENDING -> PROCESSING", () => {
      expect(
        isValidTransition(PaymentStatus.PENDING, PaymentStatus.PROCESSING),
      ).toBe(true);
    });

    it("should allow PROCESSING -> COMPLETED", () => {
      expect(
        isValidTransition(PaymentStatus.PROCESSING, PaymentStatus.COMPLETED),
      ).toBe(true);
    });

    it("should allow PROCESSING -> FAILED", () => {
      expect(
        isValidTransition(PaymentStatus.PROCESSING, PaymentStatus.FAILED),
      ).toBe(true);
    });

    it("should allow PROCESSING -> REQUIRES_RECONCILIATION", () => {
      expect(
        isValidTransition(
          PaymentStatus.PROCESSING,
          PaymentStatus.REQUIRES_RECONCILIATION,
        ),
      ).toBe(true);
    });

    it("should allow REQUIRES_RECONCILIATION -> PROCESSING", () => {
      expect(
        isValidTransition(
          PaymentStatus.REQUIRES_RECONCILIATION,
          PaymentStatus.PROCESSING,
        ),
      ).toBe(true);
    });

    it("should allow REQUIRES_RECONCILIATION -> COMPLETED", () => {
      expect(
        isValidTransition(
          PaymentStatus.REQUIRES_RECONCILIATION,
          PaymentStatus.COMPLETED,
        ),
      ).toBe(true);
    });

    it("should reject PENDING -> COMPLETED (skip PROCESSING)", () => {
      expect(
        isValidTransition(PaymentStatus.PENDING, PaymentStatus.COMPLETED),
      ).toBe(false);
    });

    it("should reject COMPLETED -> PROCESSING (terminal state)", () => {
      expect(
        isValidTransition(PaymentStatus.COMPLETED, PaymentStatus.PROCESSING),
      ).toBe(false);
    });

    it("should reject FAILED -> PROCESSING (terminal state)", () => {
      expect(
        isValidTransition(PaymentStatus.FAILED, PaymentStatus.PROCESSING),
      ).toBe(false);
    });

    it("should reject REQUIRES_RECONCILIATION -> FAILED", () => {
      expect(
        isValidTransition(
          PaymentStatus.REQUIRES_RECONCILIATION,
          PaymentStatus.FAILED,
        ),
      ).toBe(false);
    });
  });

  describe("isTerminalState", () => {
    it("should identify COMPLETED as terminal", () => {
      expect(isTerminalState(PaymentStatus.COMPLETED)).toBe(true);
    });

    it("should identify FAILED as terminal", () => {
      expect(isTerminalState(PaymentStatus.FAILED)).toBe(true);
    });

    it("should not identify PENDING as terminal", () => {
      expect(isTerminalState(PaymentStatus.PENDING)).toBe(false);
    });

    it("should not identify PROCESSING as terminal", () => {
      expect(isTerminalState(PaymentStatus.PROCESSING)).toBe(false);
    });

    it("should not identify REQUIRES_RECONCILIATION as terminal", () => {
      expect(isTerminalState(PaymentStatus.REQUIRES_RECONCILIATION)).toBe(
        false,
      );
    });
  });

  describe("getValidNextStates", () => {
    it("should return [PROCESSING] for PENDING", () => {
      expect(getValidNextStates(PaymentStatus.PENDING)).toEqual([
        PaymentStatus.PROCESSING,
      ]);
    });

    it("should return 3 states for PROCESSING", () => {
      const nextStates = getValidNextStates(PaymentStatus.PROCESSING);
      expect(nextStates).toHaveLength(3);
      expect(nextStates).toContain(PaymentStatus.COMPLETED);
      expect(nextStates).toContain(PaymentStatus.FAILED);
      expect(nextStates).toContain(PaymentStatus.REQUIRES_RECONCILIATION);
    });

    it("should return [PROCESSING, COMPLETED] for REQUIRES_RECONCILIATION", () => {
      const nextStates = getValidNextStates(
        PaymentStatus.REQUIRES_RECONCILIATION,
      );
      expect(nextStates).toHaveLength(2);
      expect(nextStates).toContain(PaymentStatus.PROCESSING);
      expect(nextStates).toContain(PaymentStatus.COMPLETED);
    });

    it("should return empty array for COMPLETED", () => {
      expect(getValidNextStates(PaymentStatus.COMPLETED)).toEqual([]);
    });

    it("should return empty array for FAILED", () => {
      expect(getValidNextStates(PaymentStatus.FAILED)).toEqual([]);
    });
  });
});
