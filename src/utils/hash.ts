import crypto from "crypto";

/**
 * Generate SHA-256 hash of request body for idempotency comparison
 * Uses canonical JSON serialization (sorted keys) to ensure same payload = same hash
 */
export function hashRequestBody(body: Record<string, any>): string {
  const canonical = JSON.stringify(sortObjectKeys(body));
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Generate provider idempotency key deterministically from gateway key
 * Format: gateway-<first 8 chars of SHA-256 hash of gateway key>
 */
export function deriveProviderIdempotencyKey(gatewayKey: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(gatewayKey, "utf8")
    .digest("hex");
  return `gateway-${hash.substring(0, 8)}`;
}

/**
 * Recursively sort object keys for canonical serialization
 */
function sortObjectKeys(obj: any): any {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }

  const sorted: Record<string, any> = {};
  Object.keys(obj)
    .sort()
    .forEach((key) => {
      sorted[key] = sortObjectKeys(obj[key]);
    });

  return sorted;
}
