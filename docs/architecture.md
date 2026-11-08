# Architecture — Payment Idempotency Gateway

Stage 1 is implemented and verified against real PostgreSQL. Payment acquisition
uses transaction-aware repositories, an atomic idempotency-key claim, a stable
provider idempotency key, and claim-generation fencing for stale workers.

The transaction lock order is:

`idempotency_keys -> payments -> payment_events`

Provider HTTP calls remain outside database transactions. Provider-result
persistence verifies the worker's claim generation before changing payment or
idempotency state.

The PostgreSQL integration suite uses Testcontainers with dynamically mapped
connection settings, explicit application-pool teardown, and forked Vitest
processes for parallel isolation. Complete-suite verification passed 66/66 in
both parallel and serial execution on 2026-11-08.

Stage 2 is implemented. Webhooks are claimed durably before business effects,
with canonical payload hashes, duplicate-delivery conflict history, provider
revision tracking, terminal-state protection, durable provider-state conflicts,
orphan recovery, and independent charge-ID/provider-key correlation. A
non-null provider charge ID is unique across payments.

The API does not currently implement authentication, merchant/account
authorization, or multi-tenant idempotency-key scoping; those are explicitly
outside this project scope.

The Stage 3 preflight correction routes reconciliation provider responses
through the fenced shared observation path. Succeeded responses complete the
payment, failed responses fail it, and unknown responses preserve recovery
state. A webhook-established terminal result prevents an older reconciliation
worker from persisting its result.

Phase 3B–3D add three separate PostgreSQL-backed recovery workers. Uncertain
payments, provider conflicts and orphaned webhooks have workflow-specific
claims and statuses, but share 60-second leases, token fencing, bounded
backoff, eight-attempt manual review and a per-process limit of four provider
operations. Orphan recovery reapplies the original observation without
creating a second webhook delivery and preserves terminal payment states.

Phase 3E adds lightweight operational observability without introducing a new
infrastructure dependency. The gateway exposes a read-only `/metrics` endpoint
with process-local HTTP counters and recovery gauges. The three recovery workers
emit structured lifecycle, poll, claim, in-flight, outcome, stale-ownership and
manual-review events. Recovery counters are labelled by workflow
(`uncertain_payment`, `provider_conflict`, or `orphaned_webhook`) and outcomes
(`resolved`, `retrying`, `manual_review`, `stale`, or `failed`). These metrics are
intended for local verification and log-based monitoring; a production deployment
would export them to a durable metrics backend.

Migration rollback is operationally restricted. Migration 003 must not be
rolled back while claim-generation fencing data may be active. Migration 004
can remove durable Stage 2 conflict evidence and must only be rolled back when
that evidence is intentionally absent. Migration 005 refuses rollback when
nullable Stage 2 data or correlation-conflict records would be lost or made
invalid.

Known limitations are the permissive Redis stub, simulator-only E2E tests, and
the Docker Compose duplicate-volume configuration.
