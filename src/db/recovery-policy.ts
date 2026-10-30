export const RECOVERY_POLICY = {
  leaseMs: 60_000,
  pollIntervalMs: 5_000,
  batchSize: 25,
  maxInFlight: 4,
  maxAttempts: 8,
  maxBackoffMs: 15 * 60_000,
} as const;

export type RecoveryClaimOptions = {
  batchSize?: number;
  now?: Date;
  leaseMs?: number;
};

export const recoveryDeadline = (now: Date, leaseMs: number): Date =>
  new Date(now.getTime() - leaseMs);
