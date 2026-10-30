# Idempotency Design
App-level (Tx 1/2 + FOR UPDATE) + provider-scoped key + reconciliation (REQUIRES_RECONCILIATION -> query by provider_idempotency_key). State machine: PENDING -> PROCESSING -> COMPLETED | FAILED | REQUIRES_RECONCILIATION.
