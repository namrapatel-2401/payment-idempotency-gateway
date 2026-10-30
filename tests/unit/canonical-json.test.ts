import { describe, expect, it } from "vitest";
import { hashCanonicalJson } from "../../src/utils/canonical-json.js";

describe("canonical webhook payload hashing", () => {
  it("ignores object key ordering and whitespace", () => {
    const first = JSON.parse('{"event_id":"evt-1","status":"succeeded","nested":{"b":2,"a":1}}');
    const second = JSON.parse('{ "nested": { "a": 1, "b": 2 }, "status": "succeeded", "event_id": "evt-1" }');
    expect(hashCanonicalJson(first)).toBe(hashCanonicalJson(second));
  });

  it("preserves array ordering", () => {
    expect(hashCanonicalJson({ values: [1, 2] })).not.toBe(
      hashCanonicalJson({ values: [2, 1] }),
    );
  });
});
