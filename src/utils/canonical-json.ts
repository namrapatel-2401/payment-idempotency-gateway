import crypto from "crypto";

const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = normalize((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }
  return value;
};

export const canonicalJson = (value: unknown): string =>
  JSON.stringify(normalize(value));

export const hashCanonicalJson = (value: unknown): string =>
  crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
