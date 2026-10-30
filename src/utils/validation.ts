export function validateIdempotencyKey(key: string): boolean {
  if (!key || typeof key !== "string") return false;
  if (key.length < 8 || key.length > 256) return false;
  return /^[a-zA-Z0-9_-]+$/.test(key);
}
export function hardenPayload(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return {};
  const allowed = [
    "amount",
    "currency",
    "provider_idempotency_key",
    "metadata",
  ];
  const out: Record<string, unknown> = {};
  for (const k of allowed)
    if (k in payload) out[k] = (payload as Record<string, unknown>)[k];
  return out;
}
