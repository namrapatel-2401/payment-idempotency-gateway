export async function expireOldKeys(db: any): Promise<number> {
  // Idempotency-key expiration cleanup (DB-side, no Docker needed)
  const res = await db.raw(
    "UPDATE idempotency_keys SET status='EXPIRED' WHERE locked_at < NOW() - INTERVAL '30 minutes' AND status='PENDING'",
  );
  return res.rowCount || 0;
}
