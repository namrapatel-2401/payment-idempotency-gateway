# Idempotency Design

Application-level idempotency uses transaction-aware repositories, row locking,
and an atomic acquisition transaction. Provider calls use a stable
provider-scoped idempotency key and occur outside database transactions.

Claim generations fence stale workers: a provider result may update payment or
idempotency state only when its generation still owns the claim. Reconciliation
queries the provider by `provider_idempotency_key` before retrying. The payment
state machine is:

`PENDING -> PROCESSING -> COMPLETED | FAILED | REQUIRES_RECONCILIATION`

`REQUIRES_RECONCILIATION -> PROCESSING | COMPLETED`

Webhook processing is transactionally deduplicated by event ID and canonical
payload hash. Provider revisions make older observations no-ops, while
contradictory terminal observations preserve the existing terminal payment
state and create durable provider conflicts for later provider lookup.

Webhook correlation independently resolves the provider idempotency key and
charge ID. Either identifier may be used alone; when both are supplied they
must identify the same payment. Mismatches are durable provider-correlation
conflicts and never mutate payment state. A unique non-null provider charge ID
constraint prevents one charge being attached to multiple payments.

Orphaned webhook events are stored before acknowledgement and reapplied once
the payment becomes identifiable, using the same observation logic as ordinary
webhook processing. Provider HTTP calls remain outside database transactions.

Merchant/account authorization and multi-tenant idempotency-key scoping are
outside this portfolio project's scope.

The Stage 3 preflight reconciliation correction uses the same claim-validated
provider observation path for synchronous lookup results. Provider success and
failure become the corresponding terminal states; an unknown lookup keeps the
payment recoverable; and a webhook-established terminal state prevents an
older reconciliation result from overwriting it.

Migration rollback is restricted for data safety. Migration 003 must not be
rolled back while claim-generation data may be active. Migration 004 may
remove durable Stage 2 conflict history. Migration 005 refuses rollback when
nullable Stage 2 records or provider-correlation conflicts would be lost or
invalidated.
