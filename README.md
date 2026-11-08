# Payment Idempotency Gateway

A portfolio/learning project demonstrating distributed-systems payment idempotency across three layers:

1. **Application-level idempotency** (gateway request deduplication)
2. **Provider-level idempotency** (downstream provider guarantees)
3. **Reconciliation** (resolving ambiguous states by querying provider)

## Quick Start

### Prerequisites
- Node.js 20+
- Docker & Docker Compose
- PostgreSQL 16 (or use Docker)

### Setup

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Start PostgreSQL with Docker
docker compose -f docker/docker-compose.yml up postgres -d

# Run migrations
npm run migrate:latest

# Start development server
npm run dev
```

Server runs on `http://localhost:3000`

### Verify Setup

```bash
curl http://localhost:3000/health
curl http://localhost:3000/metrics
```

Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2026-09-16T16:30:00.000Z",
  "uptime": 5.2,
  "database": "connected"
}
```

## Project Status

✅ **Stage 1: Transaction propagation and atomic payment acquisition**
- Transaction-aware repository operations
- Atomic idempotency-key acquisition
- Stable provider idempotency keys
- Claim-generation fencing for stale workers
- Consistent lock order: `idempotency_keys → payments → payment_events`
- Provider HTTP calls remain outside database transactions

✅ **Integration test infrastructure**
- Testcontainers connection settings are loaded before application initialization
- Application Knex pools are closed before test pools and containers
- Parallel suites run in isolated forked processes
- PostgreSQL integration verification: 66/66 passed in both parallel and serial modes on 2026-11-08.

✅ **Stage 2: Webhook and terminal-state consistency**
- Durable webhook claiming and payload-hash conflict history
- Canonical payload hashing independent of JSON key order
- Provider revisions and terminal-state protection
- Orphan webhook recovery using the same observation application logic
- Durable provider-state and provider-correlation conflict records
- Charge-ID-only and provider-key-only webhook correlation
- Unique non-null provider charge IDs

✅ **Stage 3A–3D: Automated recovery workflows**
- PostgreSQL recovery claims with leases, tokens and claim-generation fencing
- Automated uncertain-payment reconciliation with stable-key retries
- Automated provider-conflict resolution with revision-aware terminal protection
- Automated orphaned-webhook recovery with exactly-once event application
- Per-process concurrency limits, graceful shutdown and restart recovery

✅ **Stage 3E: Observability and operational verification**
- Structured recovery lifecycle events for claims, outcomes, retries, stale ownership and manual review
- In-process counters and gauges for HTTP traffic and each recovery workflow
- Read-only `GET /metrics` endpoint for gateway process metrics
- Worker lifecycle, poll, claim, in-flight and outcome visibility through structured logs and metrics

## Tech Stack

- **Runtime**: Node.js 20 / TypeScript 5
- **Framework**: Fastify
- **Database**: PostgreSQL 16 + Knex.js
- **Validation**: Zod
- **Logging**: Pino
- **Testing**: Vitest + Testcontainers
- **Container**: Docker Compose

## Development

```bash
# Run tests
npm test

# Run specific test suite
npm run test:unit
npm run test:integration

# Create new migration
npm run migrate:make migration_name

# Rollback last migration
npm run migrate:rollback
```

## Architecture

See `docs/architecture.md`, `docs/idempotency-design.md`, and `docs/failure-scenarios.md` for the current architecture and reliability rules.

## License

MIT

## Verification & Deferred Work

- `npm run test:unit`: 69 tests pass, including Phase 3E metrics coverage.
- `npx vitest run tests/integration --pool=threads`: 66 PostgreSQL tests passed.
- `npx vitest run tests/integration --pool=threads --no-file-parallelism`: 66 PostgreSQL tests passed.
- On Windows with Docker Desktop, Testcontainers may need a session-only endpoint override:
  `$env:DOCKER_HOST = "npipe:////./pipe/dockerDesktopLinuxEngine"`.
- `npm run build`: passes; the Redis rate-limit stub remains intentionally permissive.
- Redis rate limiting remains a permissive stub and Redis integration is unverified.
- E2E tests are retry-simulator stubs, not full-stack tests.
- Docker Compose validation still requires correction for duplicate `volumes` keys.
- Merchant/account authorization and multi-tenant idempotency-key isolation are outside this portfolio project's scope.
- Metrics are process-local and are not a replacement for a durable monitoring backend; each worker process exposes its own counters in logs, while `/metrics` covers the gateway process.
- Real Redis rate limiting remains future work.
- Stage 3 preflight reconciliation correctness is complete: succeeded and failed provider lookup results use the shared fenced observation path, while unknown results remain recoverable.
- Migration 003 rollback is restricted while claim-generation fencing data may be active. Migration 004 rollback may remove durable Stage 2 conflict history and must only be used when those records are intentionally absent. Migration 005 refuses rollback when nullable Stage 2 data or correlation-conflict records would be lost or invalidated.
