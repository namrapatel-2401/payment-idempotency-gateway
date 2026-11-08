# Failure Scenarios

- Stale idempotency claim (>30s) -> a new claim generation and reconciliation.
- Provider ambiguous outcome -> `REQUIRES_RECONCILIATION`.
- Provider HTTP calls remain outside database transactions: acquire, call provider, persist result.
- Provider-result persistence is fenced by claim generation.
- Webhook deliveries are claimed durably before side effects. Same-event payload-hash conflicts are stored separately from ordinary duplicates.
- Provider revisions prevent older observations from overwriting newer state. Contradictory terminal observations preserve the existing terminal payment state and create a durable provider conflict for lookup-based resolution.
- Orphan webhooks are stored durably and reapplied exactly once when the payment becomes identifiable.
- Webhook correlation accepts a charge ID, a provider idempotency key, or both. Conflicting identifiers are durably recorded without payment mutation.
- Redis rate limiting remains deferred; the current implementation is a permissive stub.
- Merchant/account authorization and multi-tenant isolation are outside the current project scope.
- Reconciliation provider lookup success and failure are persisted through the same fenced observation path; an unknown lookup remains recoverable, and a webhook terminal result fences an older reconciliation response.
- Migration rollback is restricted: 003 may remove active fencing metadata, 004 may remove durable conflict evidence, and 005 refuses rollback when incompatible Stage 2 records exist.
- Future reliability work: classify provider errors with structured codes/statuses instead of message-substring matching.
- Future reliability work: add a full webhook-route-driven race test for a worker lookup completing after a webhook establishes a terminal result.
- Orphaned webhook recovery claims pending records with a lease, reapplies the original observation once the payment is identifiable, and preserves terminal payment states.
- Orphan correlation conflicts are durable and retried; exhausted or permanently unidentifiable records move to manual review without fabricating payment associations.
- Recovery workers emit structured lifecycle and outcome signals. Claims, retries, stale workers, manual-review transitions and in-flight counts are visible by workflow; `/metrics` exposes gateway-process counters for operational checks.
- Metrics are process-local. Restarting a process resets its counters, while PostgreSQL remains the source of truth for recovery state, attempts, leases and manual-review records.
