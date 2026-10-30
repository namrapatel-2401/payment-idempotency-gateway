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
- PostgreSQL integration suite: 36/36 passing in parallel and serial modes

✅ **Stage 2: Webhook and terminal-state consistency**
- Durable webhook claiming and payload-hash conflict history
- Canonical payload hashing independent of JSON key order
- Provider revisions and terminal-state protection
- Orphan webhook recovery using the same observation application logic
- Durable provider-state and provider-correlation conflict records
- Charge-ID-only and provider-key-only webhook correlation
- Unique non-null provider charge IDs

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

- `npm run test:unit`: 67 tests pass.
- `npm run test:integration`: 30 PostgreSQL tests pass with Docker/Testcontainers in parallel and serial modes.
- On Windows with Docker Desktop, Testcontainers may need a session-only endpoint override:
  `$env:DOCKER_HOST = "npipe:////./pipe/dockerDesktopLinuxEngine"`.
- `npm run build`: currently fails in the Redis rate-limit stub.
- Redis rate limiting remains a permissive stub and Redis integration is unverified.
- E2E tests are retry-simulator stubs, not full-stack tests.
- Docker Compose validation still requires correction for duplicate `volumes` keys.
- Merchant/account authorization and multi-tenant idempotency-key isolation are outside this portfolio project's scope.
- Stage 3 background reconciliation scheduling and real Redis rate limiting remain future work.
- Stage 3 preflight reconciliation correctness is complete: succeeded and failed provider lookup results use the shared fenced observation path, while unknown results remain recoverable.
- Migration 003 rollback is restricted while claim-generation fencing data may be active. Migration 004 rollback may remove durable Stage 2 conflict history and must only be used when those records are intentionally absent. Migration 005 refuses rollback when nullable Stage 2 data or correlation-conflict records would be lost or invalidated.
