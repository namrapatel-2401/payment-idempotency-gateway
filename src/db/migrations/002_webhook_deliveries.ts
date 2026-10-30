/**
 * Migration 002: Add webhook_deliveries and orphaned_webhooks tables for durable webhook processing.
 *
 * Importers: Knex migration runner, testDb.migrate.latest in tests/setup/test-db.ts
 * Affected API: POST /webhooks/payment-provider
 * Data schemas:
 *   - webhook_deliveries (id, webhook_id, charge_id, event_type, payload, processed_at, created_at)
 *   - orphaned_webhooks (id, webhook_id, charge_id, event_type, payload, resolved, resolved_at, received_at)
 * User instruction: "Implement all Critical and High-priority webhook issues identified in the review... Replace in-memory webhook deduplication with PostgreSQL-backed durable deduplication. Add a database UNIQUE/PRIMARY KEY constraint for webhook event IDs."
 */

import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  // Create webhook_deliveries table for durable deduplication
  await knex.schema.createTable("webhook_deliveries", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("webhook_id", 255).notNullable().unique();
    table.string("charge_id", 255).notNullable();
    table.string("event_type", 50).notNullable();
    table.jsonb("payload").defaultTo("{}");
    table
      .timestamp("processed_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());

    table.index("charge_id");
    table.index("event_type");
    table.index("processed_at");
  });

  // Create orphaned_webhooks table for storing notifications for unknown payments
  await knex.schema.createTable("orphaned_webhooks", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("webhook_id", 255).notNullable();
    table.string("charge_id", 255).notNullable();
    table.string("event_type", 50).notNullable();
    table.jsonb("payload").defaultTo("{}");
    table.boolean("resolved").notNullable().defaultTo(false);
    table.timestamp("resolved_at", { useTz: true }).nullable();
    table
      .timestamp("received_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());

    table.index("webhook_id");
    table.index("charge_id");
    table.index("resolved");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("orphaned_webhooks");
  await knex.schema.dropTableIfExists("webhook_deliveries");
}
