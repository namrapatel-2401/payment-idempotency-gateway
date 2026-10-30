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

As of 2026-10-30:

- 65 unit tests pass.
- PostgreSQL integration tests fail before assertions because Testcontainers cannot obtain a usable Docker runtime.
- Redis rate limiting is a stub that always permits requests; Redis integration is unverified.
- E2E tests are simulator stubs, not full-stack tests.
- The TypeScript build currently fails.
- Docker Compose validation currently fails because the Compose file defines duplicate `volumes` keys.
- Repository methods do not consistently use the supplied Knex transaction handle, so documented transaction boundaries require verification before being treated as reliable.
- The project directory is not currently a Git repository; Git status and history are unavailable.

These facts must be re-verified rather than assumed in future sessions.

## Change policy

- Do not modify application source code unless explicitly requested.
- Do not delete or overwrite files without explicit approval.
- Inspect existing code and tests before proposing changes.
- Keep documentation aligned with actual implementation and verified test results.
- Report concrete defects before implementing fixes.
