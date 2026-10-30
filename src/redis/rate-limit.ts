import { redisClient } from "./client.ts";
export async function checkRateLimit(
  key: string,
  max = 100,
  windowMs = 60_000,
): Promise<boolean> {
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
