import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  const duplicateProviderIds = await knex.raw<{
    rows: Array<{ provider_id: string; payment_count: string }>;
  }>(`
    SELECT provider_id, COUNT(*)::text AS payment_count
    FROM payments
    WHERE provider_id IS NOT NULL
    GROUP BY provider_id
    HAVING COUNT(*) > 1
    ORDER BY provider_id
  `);

  if (duplicateProviderIds.rows.length > 0) {
    const details = duplicateProviderIds.rows
      .map((row) => `${row.provider_id} (${row.payment_count} payments)`)
      .join(", ");
    throw new Error(
      `Migration 005 aborted: duplicate non-null provider_id values found: ${details}. Resolve the records manually; no data was changed by this check.`,
    );
  }

  // A non-null provider charge may belong to only one payment. Existing
  // duplicate data intentionally causes this migration to fail loudly rather
  // than being silently reassigned.
  await knex.raw(`
    CREATE UNIQUE INDEX payments_provider_id_unique
    ON payments (provider_id)
    WHERE provider_id IS NOT NULL
  `);

  await knex.schema.alterTable("orphaned_webhooks", (table) => {
    table.string("charge_id").nullable().alter();
  });

  await knex.schema.alterTable("webhook_deliveries", (table) => {
    table.string("charge_id").nullable().alter();
  });

  await knex.schema.alterTable("provider_conflicts", (table) => {
    table.string("charge_id").nullable().alter();
    table.string("provider_idempotency_key").nullable().alter();
  });

  await knex.schema.createTable("provider_correlation_conflicts", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("provider_event_id", 255).notNullable();
    table.string("charge_id", 255).nullable();
    table.string("provider_idempotency_key", 255).nullable();
    table.string("payload_hash", 64).notNullable();
    table.string("conflict_type", 80).notNullable();
    table.uuid("key_payment_id").nullable().references("id").inTable("payments").onDelete("SET NULL");
    table.uuid("charge_payment_id").nullable().references("id").inTable("payments").onDelete("SET NULL");
    table.jsonb("payload").notNullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(["provider_event_id", "payload_hash"]);
    table.index(["conflict_type", "created_at"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  const blockers = await knex.raw<{
    rows: Array<{ table_name: string; null_count: string }>;
  }>(`
    SELECT 'provider_conflicts' AS table_name, COUNT(*)::text AS null_count
    FROM provider_conflicts
    WHERE charge_id IS NULL OR provider_idempotency_key IS NULL
    UNION ALL
    SELECT 'orphaned_webhooks', COUNT(*)::text
    FROM orphaned_webhooks
    WHERE charge_id IS NULL
    UNION ALL
    SELECT 'webhook_deliveries', COUNT(*)::text
    FROM webhook_deliveries
    WHERE charge_id IS NULL
    UNION ALL
    SELECT 'provider_correlation_conflicts', COUNT(*)::text
    FROM provider_correlation_conflicts
  `);

  const blockingRows = blockers.rows.filter((row) => Number(row.null_count) > 0);
  if (blockingRows.length > 0) {
    const details = blockingRows
      .map((row) => `${row.table_name}: ${row.null_count} record(s)`)
      .join(", ");
    throw new Error(
      `Migration 005 rollback refused: existing Stage 2 data would be lost or made invalid (${details}). Preserve the records and resolve them explicitly before rollback.`,
    );
  }

  await knex.schema.dropTableIfExists("provider_correlation_conflicts");
  await knex.raw("DROP INDEX IF EXISTS payments_provider_id_unique");
  await knex.schema.alterTable("provider_conflicts", (table) => {
    table.string("charge_id").notNullable().alter();
    table.string("provider_idempotency_key").notNullable().alter();
  });
  await knex.schema.alterTable("orphaned_webhooks", (table) => {
    table.string("charge_id").notNullable().alter();
  });
  await knex.schema.alterTable("webhook_deliveries", (table) => {
    table.string("charge_id").notNullable().alter();
  });
}
