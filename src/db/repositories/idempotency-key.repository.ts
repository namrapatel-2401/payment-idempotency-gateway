import type { Knex } from "knex";
import { getDb } from "../connection.js";
import { IdempotencyKey } from "../../models/payment.js";
import { IdempotencyKeyStatus } from "../../models/payment-status.js";

export type DbExecutor = Knex | Knex.Transaction;

export class IdempotencyKeyRepository {
  /**
   * Insert a new idempotency key (INSERT ... ON CONFLICT DO NOTHING pattern)
   * Returns true if inserted, false if key already exists
   */
  async create(data: {
    key: string;
    request_path: string;
    request_hash: string;
  }, db: DbExecutor = getDb()): Promise<boolean> {
    const result = await db("idempotency_keys")
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
  async findAndLock(
    key: string,
    db: DbExecutor = getDb(),
  ): Promise<IdempotencyKey | null> {
    const rows = await db("idempotency_keys")
      .where({ key })
      .forUpdate()
      .select("*");

    return rows[0] || null;
  }

  /**
   * Find idempotency key by key (without locking)
   */
  async findByKey(
    key: string,
    db: DbExecutor = getDb(),
  ): Promise<IdempotencyKey | null> {
    const row = await db("idempotency_keys").where({ key }).first();

    return row || null;
  }

  /**
   * Find an idempotency key by ID while holding its row lock.
   */
  async findByIdAndLock(
    id: string,
    db: DbExecutor = getDb(),
  ): Promise<IdempotencyKey | null> {
    const row = await db("idempotency_keys")
      .where({ id })
      .forUpdate()
      .first();

    return row || null;
  }

  /**
   * Update idempotency key status
   */
  async updateStatus(
    id: string,
    status: IdempotencyKeyStatus,
    lockedAt?: Date | null,
    claimGeneration?: number,
    db: DbExecutor = getDb(),
  ): Promise<void> {
    await db("idempotency_keys").where({ id }).update({
      status,
      locked_at: lockedAt,
      ...(claimGeneration === undefined
        ? {}
        : { claim_generation: claimGeneration }),
      updated_at: db.fn.now(),
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
    db: DbExecutor = getDb(),
  ): Promise<void> {
    await db("idempotency_keys").where({ id }).update({
      response_code: responseCode,
      response_body: responseBody,
      status,
      locked_at: null,
      updated_at: db.fn.now(),
    });
  }
}
