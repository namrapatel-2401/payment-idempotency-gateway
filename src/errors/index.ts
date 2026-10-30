export class IdempotencyConflictError extends Error {
  constructor(
    message: string = "Idempotency key reused with different payload",
  ) {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export class IdempotencyKeyInFlightError extends Error {
  constructor(message: string = "Another request with this key is processing") {
    super(message);
    this.name = "IdempotencyKeyInFlightError";
  }
}

export class PaymentProviderError extends Error {
  constructor(
    message: string,
    public readonly isRetryable: boolean = true,
  ) {
    super(message);
    this.name = "PaymentProviderError";
  }
}

export class PaymentNotFoundError extends Error {
  constructor(message: string = "Payment not found") {
    super(message);
    this.name = "PaymentNotFoundError";
  }
}
