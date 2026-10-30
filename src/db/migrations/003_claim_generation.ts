import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("idempotency_keys", (table) => {
    table.integer("claim_generation").notNullable().defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("idempotency_keys", (table) => {
    table.dropColumn("claim_generation");
  });
}
