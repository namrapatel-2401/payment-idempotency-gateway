# Payment Idempotency Gateway — Codex Project Guide

## Project scope

This is an existing TypeScript/Fastify portfolio project demonstrating:

- Application-level idempotency
- Provider-level idempotency
- Payment state machines
- PostgreSQL transactions and concurrency control
- Reconciliation after ambiguous provider outcomes
- Webhook HMAC verification and durable deduplication
- Redis rate limiting
- Idempotency-key cleanup
- Structured logging and observability
- Retry simulation and E2E testing

Do not recreate, rewrite, or replace existing implementations. Preserve the existing architecture unless a concrete defect is demonstrated.

## Technology and directories

- Node.js 20+, TypeScript, Fastify 4, PostgreSQL 16, Knex, Zod, Vitest, Testcontainers, Docker Compose, Redis
- `src/` — gateway implementation
- `src/db/migrations/` — PostgreSQL migrations
- `src/db/repositories/` — persistence access
- `src/services/` — idempotency and provider orchestration
- `src/routes/` — payment and webhook APIs
- `src/redis/` — Redis client and rate limiting
- `provider/` — simulated downstream provider
- `tests/unit/` — unit tests
- `tests/integration/` — Testcontainers/PostgreSQL tests
- `tests/e2e/` — E2E tests
- `docs/` — architecture and failure documentation
- `docker/` — Dockerfile and Compose configuration

## Commands

```bash
npm install
npm run build
npm run test:unit
npm run test:integration
npm run test:e2e
npm test
npm run migrate:latest
npm run migrate:rollback
npm run dev
npm run dev:provider
```

Always execute tests before claiming they pass. Distinguish unit, integration, Redis, and E2E verification.

## Architectural invariants

- Provider HTTP calls must occur outside database transactions.
- Database operations described as transactional must use the same Knex transaction handle.
- Application idempotency uses `Idempotency-Key`.
- Provider calls use a provider-scoped idempotency key.
- Ambiguous provider outcomes transition to reconciliation.
- Reconciliation queries provider state before retrying.
- Webhook delivery deduplication is durable in PostgreSQL.
- Terminal payment states must not be overwritten by later webhooks.
- Webhook signatures must be checked against the exact received payload.
- Do not introduce blind retries for ambiguous payment outcomes.

## Current audit baseline

Verified 2026-10-30:

- Stage 1 is implemented and approved: transaction-aware repository calls, atomic payment acquisition, stable provider idempotency keys, claim-generation fencing, and the lock order `idempotency_keys -> payments -> payment_events`.
- 67 unit tests pass.
- PostgreSQL integration tests pass against real Testcontainers PostgreSQL: 36/36 in parallel mode and 36/36 in serial mode.
- Integration setup reloads the dynamic container configuration, resets and closes the application Knex pool, stops containers after pool teardown, and uses forked Vitest processes for parallel isolation.
- Redis rate limiting is still a stub that always permits requests; Redis integration is unverified.
- E2E tests are simulator stubs, not full-stack tests.
- The TypeScript build currently fails in `src/redis/rate-limit.ts` because of a `.ts` import extension and unused stub parameters.
- Docker Compose validation still fails because the Compose file defines duplicate `volumes` keys.
- The project is a Git repository with the initial baseline commit. Stage 1 and test-infrastructure changes remain uncommitted; `.claude/` remains untracked and must not be committed.
- Stage 2 is implemented and verified: durable webhook claiming, canonical payload hashes, provider revisions, terminal-state protection, orphan recovery, durable provider-state conflicts, provider-correlation conflicts, legacy charge-ID fallback, and unique provider charge IDs.
- Stage 3 preflight correctness is implemented and verified: provider lookup success/failure results use fenced shared observation persistence, null lookup outcomes remain recoverable, and webhook-established terminal results fence older reconciliation responses.
- Migration rollback restrictions: migration 003 must not be rolled back while claim-generation fencing data may be active; migration 004 can remove durable Stage 2 conflict evidence and is restricted to databases where that evidence is intentionally absent; migration 005 refuses rollback when nullable Stage 2 data or correlation-conflict records would be lost or invalidated.
- Merchant/account authorization and multi-tenant idempotency-key isolation are outside the current project scope.

Re-verify these facts before future claims about completion.

## Change policy

- Do not modify application source code unless explicitly requested.
- Do not delete or overwrite files without explicit approval.
- Inspect existing code and tests before proposing changes.
- Keep documentation aligned with actual implementation and verified test results.
- Report concrete defects before implementing fixes.
