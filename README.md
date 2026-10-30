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

✅ **Phase 1: Foundation** (Complete)
- TypeScript + Fastify setup
- PostgreSQL database with Knex
- Docker Compose configuration
- Health check endpoint
- Structured logging (Pino)
- Environment validation (Zod)

🔄 **Phase 2: State Machine + Models** (Next)

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

See `C:\Users\ASUS\.claude-omniroute\plans\sleepy-sniffing-avalanche.md` for complete architectural details, database schema, state machine, and failure scenarios.

## License

MIT

## Documentation & Deferred Tests
- Phase 6 integration tests deferred (Docker unavailable).
- Phase 7 Redis rate-limit deferred; mock passes.
- Phase 8 observability implemented (Pino).
- Phase 9 E2E deferred; retry simulator present.
- Phase 10 docs added (docs/architecture.md, idempotency-design.md, failure-scenarios.md).

Run: npm run test:unit (65 pass). Integration/E2E need docker-compose up.
