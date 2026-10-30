import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("idempotency_keys", (table) => {
    table.string("reconciliation_status", 30).nullable();
    table.integer("reconciliation_attempts").notNullable().defaultTo(0);
    table.timestamp("next_reconciliation_at", { useTz: true }).nullable();
    table.string("reconciliation_claim_token", 100).nullable();
    table.timestamp("reconciliation_locked_at", { useTz: true }).nullable();
    table.text("reconciliation_last_error").nullable();
    table.timestamp("reconciliation_manual_review_at", { useTz: true }).nullable();
    table.timestamp("reconciliation_resolved_at", { useTz: true }).nullable();
  });

  await knex.schema.alterTable("provider_conflicts", (table) => {
    table.timestamp("next_resolution_at", { useTz: true }).nullable();
    table.text("resolution_last_error").nullable();
    table.timestamp("resolution_manual_review_at", { useTz: true }).nullable();
    table.timestamp("resolution_started_at", { useTz: true }).nullable();
  });

  await knex.schema.alterTable("orphaned_webhooks", (table) => {
    table.string("recovery_status", 30).nullable();
    table.integer("recovery_attempts").notNullable().defaultTo(0);
    table.timestamp("next_recovery_at", { useTz: true }).nullable();
    table.string("recovery_claim_token", 100).nullable();
    table.timestamp("recovery_locked_at", { useTz: true }).nullable();
    table.text("recovery_last_error").nullable();
    table.timestamp("recovery_manual_review_at", { useTz: true }).nullable();
    table.timestamp("recovery_resolved_at", { useTz: true }).nullable();
    table.string("recovery_resolution", 50).nullable();
  });

  await knex("idempotency_keys")
    .where({ status: "requires_reconciliation" })
    .whereNull("reconciliation_status")
    .update({
      reconciliation_status: "pending",
      next_reconciliation_at: knex.fn.now(),
    });

  await knex("orphaned_webhooks")
    .where({ resolved: true })
    .whereNull("recovery_status")
    .update({
      recovery_status: "resolved",
      recovery_resolved_at: knex.fn.now(),
      recovery_resolution: "legacy_resolved",
    });

  await knex.raw("ALTER TABLE orphaned_webhooks ALTER COLUMN recovery_status SET DEFAULT 'pending'");

  await knex("orphaned_webhooks")
    .where({ resolved: false })
    .whereNull("recovery_status")
    .update({
      recovery_status: "pending",
      next_recovery_at: knex.fn.now(),
    });

  await knex.schema.alterTable("idempotency_keys", (table) => {
    table.index(["reconciliation_status", "next_reconciliation_at"]);
    table.index(["reconciliation_status", "reconciliation_locked_at"]);
  });

  await knex.schema.alterTable("provider_conflicts", (table) => {
    table.index(["status", "next_resolution_at"]);
    table.index(["status", "resolution_locked_at"]);
  });

  await knex.schema.alterTable("orphaned_webhooks", (table) => {
    table.index(["recovery_status", "next_recovery_at"]);
    table.index(["recovery_status", "recovery_locked_at"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  const blockers = await knex.raw<{ rows: Array<{ table_name: string; count: string }> }>(`
    SELECT 'idempotency_keys' AS table_name, COUNT(*)::text AS count
    FROM idempotency_keys
    WHERE reconciliation_attempts > 0
       OR reconciliation_claim_token IS NOT NULL
       OR reconciliation_last_error IS NOT NULL
       OR reconciliation_manual_review_at IS NOT NULL
       OR reconciliation_resolved_at IS NOT NULL
    UNION ALL
    SELECT 'provider_conflicts', COUNT(*)::text
    FROM provider_conflicts
    WHERE resolution_started_at IS NOT NULL
       OR resolution_last_error IS NOT NULL
       OR resolution_manual_review_at IS NOT NULL
    UNION ALL
    SELECT 'orphaned_webhooks', COUNT(*)::text
    FROM orphaned_webhooks
    WHERE recovery_attempts > 0
       OR recovery_claim_token IS NOT NULL
       OR recovery_last_error IS NOT NULL
       OR recovery_manual_review_at IS NOT NULL
       OR recovery_resolved_at IS NOT NULL
       OR recovery_resolution IS NOT NULL
  `);

  const blockingRows = blockers.rows.filter((row) => Number(row.count) > 0);
  if (blockingRows.length > 0) {
    const details = blockingRows
      .map((row) => `${row.table_name}: ${row.count} record(s)`)
      .join(", ");
    throw new Error(
      `Migration 006 rollback refused: recovery claim history would be lost (${details}). Preserve the records and resolve them explicitly before rollback.`,
    );
  }

  await knex.schema.alterTable("orphaned_webhooks", (table) => {
    table.dropIndex(["recovery_status", "next_recovery_at"]);
    table.dropIndex(["recovery_status", "recovery_locked_at"]);
    table.dropColumn("recovery_status");
    table.dropColumn("recovery_attempts");
    table.dropColumn("next_recovery_at");
    table.dropColumn("recovery_claim_token");
    table.dropColumn("recovery_locked_at");
    table.dropColumn("recovery_last_error");
    table.dropColumn("recovery_manual_review_at");
    table.dropColumn("recovery_resolved_at");
    table.dropColumn("recovery_resolution");
  });

  await knex.schema.alterTable("provider_conflicts", (table) => {
    table.dropIndex(["status", "next_resolution_at"]);
    table.dropIndex(["status", "resolution_locked_at"]);
    table.dropColumn("next_resolution_at");
    table.dropColumn("resolution_last_error");
    table.dropColumn("resolution_manual_review_at");
    table.dropColumn("resolution_started_at");
  });

  await knex.schema.alterTable("idempotency_keys", (table) => {
    table.dropIndex(["reconciliation_status", "next_reconciliation_at"]);
    table.dropIndex(["reconciliation_status", "reconciliation_locked_at"]);
    table.dropColumn("reconciliation_status");
    table.dropColumn("reconciliation_attempts");
    table.dropColumn("next_reconciliation_at");
    table.dropColumn("reconciliation_claim_token");
    table.dropColumn("reconciliation_locked_at");
    table.dropColumn("reconciliation_last_error");
    table.dropColumn("reconciliation_manual_review_at");
    table.dropColumn("reconciliation_resolved_at");
  });
}
