# Payment Idempotency Gateway — Project Guide

## Overview
A portfolio and learning project demonstrating distributed-systems payment idempotency across three distinct boundaries:
1. **Application-level idempotency**: Gateway request deduplication & cached response replay.
2. **Provider-level idempotency**: Downstream payment provider accepting provider-scoped idempotency keys.
3. **Reconciliation**: Resolving ambiguous / in-doubt outcomes by querying provider state prior to retrying.

## Stack
- **Runtime**: Node.js 20+ (ESM) / TypeScript 5.x
- **Framework**: Fastify 4.x (native JSON validation, Pino logger, high performance)
- **Database & Query Layer**: PostgreSQL 16 + Knex.js
- **Validation**: Zod 3.x
- **Logging**: Pino 8.x
- **Testing**: Vitest + Testcontainers + Supertest
- **Containerization**: Docker Compose

## Development Commands
```bash
npm install              # Install dependencies
npm run dev              # Run server with tsx watch
npm run build            # Compile TypeScript to dist/
npm run migrate:latest   # Run Knex database migrations
npm run migrate:rollback # Rollback last migration
npm run test             # Run Vitest test suite
npm run test:unit        # Run unit tests
npm run test:integration # Run integration tests (with Testcontainers)
```

## Architecture & Code Conventions
- **Transaction Boundaries**:
  - *Tx 1 (Acquire Key)*: Insert idempotency key, insert pending payment, lock row.
  - *Provider HTTP Call*: Executed STRICTLY OUTSIDE active DB transactions.
  - *Tx 2 (Save Outcome)*: Update payment status, append audit record to `payment_events`, update `idempotency_keys` with cached response.
- **Concurrency & Locking**:
  - Eliminates TOCTOU races with `INSERT ... ON CONFLICT (key) DO NOTHING` + `SELECT ... FOR UPDATE`.
  - Stale lock detection on in-flight requests (`locked_at` > 30s) triggers reconciliation rather than blind retry.
- **State Machine**:
  - `PENDING` -> `PROCESSING` -> `COMPLETED` | `FAILED` | `REQUIRES_RECONCILIATION`
  - `REQUIRES_RECONCILIATION` queries provider by `provider_idempotency_key` before proceeding.
