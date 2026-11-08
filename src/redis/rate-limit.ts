import { redisClient } from "./client.js";
export async function checkRateLimit(
  key: string,
  max = 100,
  windowMs = 60_000,
): Promise<boolean> {
  // Redis rate limiting remains intentionally permissive until the real
  // sliding-window implementation is introduced.
  void key;
  void max;
  void windowMs;
  try {
    await Promise.race([
      redisClient.connect(),
      new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 500)),
    ]);
  } catch {
    return true;
  }
  // Real sliding-window logic deferred until Redis container available
  return true;
}
