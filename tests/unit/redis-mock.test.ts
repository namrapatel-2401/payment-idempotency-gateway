import { describe, it, expect } from "vitest";
import { checkRateLimit } from "../../src/redis/rate-limit";
describe("Phase 7 mock", () => {
  it("rate mock", async () => {
    expect(await checkRateLimit("k")).toBe(true);
  });
});
