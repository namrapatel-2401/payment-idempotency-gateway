import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  // Create idempotency_keys table
  await knex.schema.createTable("idempotency_keys", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("key", 255).notNullable().unique();
    table.string("request_path", 255).notNullable();
    table.string("request_hash", 64).notNullable();
    table.string("status", 50).notNullable().defaultTo("pending");
    table.integer("response_code").nullable();
    table.jsonb("response_body").nullable();
    table.timestamp("locked_at", { useTz: true }).nullable();
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table
      .timestamp("updated_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table
      .timestamp("expires_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.raw("NOW() + INTERVAL '24 hours'"));

    table.index("status");
    table.index("expires_at");
  });

  // Create payments table
  await knex.schema.createTable("payments", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("idempotency_key_id")
      .notNullable()
      .references("id")
      .inTable("idempotency_keys")
      .onDelete("CASCADE");
    table.string("provider_idempotency_key", 255).notNullable().unique();
    table.decimal("amount", 12, 2).notNullable();
    table.string("currency", 3).notNullable();
    table.string("customer_email", 255).notNullable();
    table.text("description").nullable();
    table.string("status", 50).notNullable().defaultTo("pending");
    table.string("provider_id", 255).nullable();
    table.string("provider_status", 50).nullable();
    table.text("failure_reason").nullable();
    table.jsonb("metadata").defaultTo("{}");
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table
      .timestamp("updated_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());

    table.unique(["idempotency_key_id"]);
    table.index("status");
    table.index("provider_id");
  });

  // Create payment_events table (audit log)
  await knex.schema.createTable("payment_events", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("payment_id")
      .notNullable()
      .references("id")
      .inTable("payments")
      .onDelete("CASCADE");
    table.string("event_type", 50).notNullable();
    table.jsonb("details").defaultTo("{}");
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());

    table.index("payment_id");
    table.index("event_type");
    table.index("created_at");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("payment_events");
  await knex.schema.dropTableIfExists("payments");
  await knex.schema.dropTableIfExists("idempotency_keys");
}
