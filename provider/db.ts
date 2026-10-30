import crypto from 'crypto';

export interface ProviderCharge {
  id: string;
  idempotency_key: string;
  request_hash: string;
  amount: number;
  currency: string;
  customer_email: string;
  description?: string;
  status: 'succeeded' | 'failed';
  failure_message?: string;
  created_at: Date;
}

// In-memory storage for provider-side charges and idempotency records
const charges = new Map<string, ProviderCharge>();
const idempotencyKeyIndex = new Map<string, string>(); // idempotency_key -> charge_id

export const initDatabase = async (): Promise<void> => {
  // In-memory initialization (resets on restart)
  charges.clear();
  idempotencyKeyIndex.clear();
};

export const findChargeByIdempotencyKey = (
  idempotencyKey: string
): ProviderCharge | null => {
  const chargeId = idempotencyKeyIndex.get(idempotencyKey);
  if (!chargeId) return null;
  return charges.get(chargeId) || null;
};

export const findChargeById = (id: string): ProviderCharge | null => {
  return charges.get(id) || null;
};

export const createCharge = (
  idempotencyKey: string,
  requestHash: string,
  data: {
    amount: number;
    currency: string;
    customer_email: string;
    description?: string;
    status: 'succeeded' | 'failed';
    failure_message?: string;
  }
): ProviderCharge => {
  const id = `ch_${crypto.randomBytes(12).toString('hex')}`;

  const charge: ProviderCharge = {
    id,
    idempotency_key: idempotencyKey,
    request_hash: requestHash,
    ...data,
    created_at: new Date(),
  };

  charges.set(id, charge);
  idempotencyKeyIndex.set(idempotencyKey, id);

  return charge;
};

export const clearDatabase = (): void => {
  charges.clear();
  idempotencyKeyIndex.clear();
};
