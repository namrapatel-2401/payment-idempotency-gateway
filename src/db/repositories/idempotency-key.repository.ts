import { getDb } from "../connection.js";
import { IdempotencyKey } from "../../models/payment.js";
import { IdempotencyKeyStatus } from "../../models/payment-status.js";

export class IdempotencyKeyRepository {
  /**
   * Insert a new idempotency key (INSERT ... ON CONFLICT DO NOTHING pattern)
   * Returns true if inserted, false if key already exists
   */
  async create(data: {
    key: string;
    request_path: string;
    request_hash: string;
  }): Promise<boolean> {
    const result = await getDb()("idempotency_keys")
      .insert({
        key: data.key,
        request_path: data.request_path,
        request_hash: data.request_hash,
        status: IdempotencyKeyStatus.PENDING,
      })
      .onConflict("key")
      .ignore();

    return result.length > 0;
  }

  /**
   * Acquire exclusive lock on idempotency key row (SELECT ... FOR UPDATE)
   * This serializes concurrent requests with the same key
   */
  async findAndLock(key: string): Promise<IdempotencyKey | null> {
    const rows = await getDb()("idempotency_keys")
      .where({ key })
      .forUpdate()
      .select("*");

    return rows[0] || null;
  }

  /**
   * Find idempotency key by key (without locking)
   */
  async findByKey(key: string): Promise<IdempotencyKey | null> {
    const row = await getDb()("idempotency_keys").where({ key }).first();

    return row || null;
  }

  /**
   * Update idempotency key status
   */
  async updateStatus(
    id: string,
    status: IdempotencyKeyStatus,
    lockedAt?: Date | null,
  ): Promise<void> {
    await getDb()("idempotency_keys").where({ id }).update({
      status,
      locked_at: lockedAt,
      updated_at: getDb().fn.now(),
    });
  }

  /**
   * Cache response in idempotency key
   */
  async cacheResponse(
    id: string,
    responseCode: number,
    responseBody: any,
    status: IdempotencyKeyStatus,
  ): Promise<void> {
    await getDb()("idempotency_keys").where({ id }).update({
      response_code: responseCode,
      response_body: responseBody,
      status,
      locked_at: null,
      updated_at: getDb().fn.now(),
    });
  }
}
