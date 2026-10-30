import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("payments", (table) => {
    table.integer("provider_revision").nullable();
    table.timestamp("provider_event_at", { useTz: true }).nullable();
    table.string("provider_observation_source", 30).nullable();
  });

  await knex.schema.alterTable("webhook_deliveries", (table) => {
    table.string("payload_hash", 64).nullable();
    table.integer("provider_revision").nullable();
    table.timestamp("provider_event_at", { useTz: true }).nullable();
  });

  await knex.schema.alterTable("orphaned_webhooks", (table) => {
    table.string("provider_idempotency_key", 255).nullable();
    table.string("payload_hash", 64).nullable();
  });

  await knex.schema.createTable("provider_conflicts", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("payment_id").nullable().references("id").inTable("payments").onDelete("CASCADE");
    table.uuid("idempotency_key_id")
      .nullable()
      .references("id")
      .inTable("idempotency_keys")
      .onDelete("CASCADE");
    table.string("provider_event_id", 255).notNullable();
    table.string("charge_id", 255).notNullable();
    table.string("provider_idempotency_key", 255).notNullable();
    table.string("payload_hash", 64).notNullable();
    table.string("incoming_status", 50).notNullable();
    table.integer("incoming_revision").nullable();
    table.string("current_status", 50).nullable();
    table.string("status", 30).notNullable().defaultTo("pending");
    table.string("resolution", 50).nullable();
    table.jsonb("payload").notNullable();
    table.integer("resolution_attempts").notNullable().defaultTo(0);
    table.string("resolution_claim_token", 100).nullable();
    table.timestamp("resolution_locked_at", { useTz: true }).nullable();
    table.timestamp("resolved_at", { useTz: true }).nullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(["provider_event_id", "payload_hash"]);
    table.index(["payment_id", "status"]);
    table.index(["idempotency_key_id", "status"]);
  });

  await knex.schema.createTable("webhook_delivery_conflicts", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("webhook_delivery_id").notNullable()
      .references("id").inTable("webhook_deliveries").onDelete("CASCADE");
    table.string("payload_hash", 64).notNullable();
    table.jsonb("payload").notNullable();
    table.timestamp("received_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(["webhook_delivery_id", "payload_hash"]);
  });

  await knex.raw(`
    UPDATE orphaned_webhooks
    SET provider_idempotency_key = payload->>'idempotency_key'
    WHERE provider_idempotency_key IS NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("provider_conflicts");
  await knex.schema.dropTableIfExists("webhook_delivery_conflicts");
  await knex.schema.alterTable("orphaned_webhooks", (table) => {
    table.dropColumn("provider_idempotency_key");
    table.dropColumn("payload_hash");
  });
  await knex.schema.alterTable("webhook_deliveries", (table) => {
    table.dropColumn("payload_hash");
    table.dropColumn("provider_revision");
    table.dropColumn("provider_event_at");
  });
  await knex.schema.alterTable("payments", (table) => {
    table.dropColumn("provider_revision");
    table.dropColumn("provider_event_at");
    table.dropColumn("provider_observation_source");
  });
}
