// Payment status enum
export enum PaymentStatus {
  PENDING = "pending",
  PROCESSING = "processing",
  COMPLETED = "completed",
  FAILED = "failed",
  REQUIRES_RECONCILIATION = "requires_reconciliation",
}

// Idempotency key status enum (matches payment status)
export enum IdempotencyKeyStatus {
  PENDING = "pending",
  PROCESSING = "processing",
  COMPLETED = "completed",
  FAILED = "failed",
  REQUIRES_RECONCILIATION = "requires_reconciliation",
}

// Valid state transitions for the payment state machine
const VALID_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  [PaymentStatus.PENDING]: [PaymentStatus.PROCESSING],
  [PaymentStatus.PROCESSING]: [
    PaymentStatus.COMPLETED,
    PaymentStatus.FAILED,
    PaymentStatus.REQUIRES_RECONCILIATION,
  ],
  [PaymentStatus.REQUIRES_RECONCILIATION]: [
    PaymentStatus.PROCESSING,
    PaymentStatus.COMPLETED,
  ],
  [PaymentStatus.COMPLETED]: [], // Terminal state
  [PaymentStatus.FAILED]: [], // Terminal state
};

// Terminal states (no further transitions allowed)
export const TERMINAL_STATES = [
  PaymentStatus.COMPLETED,
  PaymentStatus.FAILED,
] as const;

/**
 * Validates whether a state transition is allowed by the state machine
 */
export const isValidTransition = (
  from: PaymentStatus,
  to: PaymentStatus,
): boolean => {
  const allowedTransitions = VALID_TRANSITIONS[from];
  return allowedTransitions.includes(to);
};

/**
 * Checks if a status is terminal (no further transitions)
 */
export const isTerminalState = (status: PaymentStatus): boolean => {
  return TERMINAL_STATES.includes(status as any);
};

/**
 * Gets all valid next states for a given current state
 */
export const getValidNextStates = (
  currentStatus: PaymentStatus,
): PaymentStatus[] => {
  return VALID_TRANSITIONS[currentStatus] || [];
};
