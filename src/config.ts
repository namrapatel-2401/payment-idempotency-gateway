import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z
    .string()
    .transform(Number)
    .pipe(z.number().int().positive())
    .default("3000"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  CORS_ORIGIN: z.string().url().optional(),

  DB_HOST: z.string().default("localhost"),
  DATABASE_URL: z.string().url().optional(),
  DB_PORT: z
    .string()
    .transform(Number)
    .pipe(z.number().int().positive())
    .default("5432"),
  DB_NAME: z.string().default("payment_gateway"),
  DB_USER: z.string().default("postgres"),
  DB_PASSWORD: z.string().default("postgres"),
  DB_POOL_MIN: z
    .string()
    .transform(Number)
    .pipe(z.number().int().nonnegative())
    .default("2"),
  DB_POOL_MAX: z
    .string()
    .transform(Number)
    .pipe(z.number().int().positive())
    .default("10"),

  PROVIDER_BASE_URL: z.string().url().default("http://localhost:3001"),
  PROVIDER_TIMEOUT_MS: z
    .string()
    .transform(Number)
    .pipe(z.number().int().positive())
    .default("10000"),
  WEBHOOK_SECRET: z
    .string()
    .min(32, "WEBHOOK_SECRET must be at least 32 characters long")
    .default("dev-secret-change-in-production-must-be-32-chars-long"),

  IDEMPOTENCY_KEY_TTL_HOURS: z
    .string()
    .transform(Number)
    .pipe(z.number().int().positive())
    .default("24"),
  STALE_LOCK_THRESHOLD_MS: z
    .string()
    .transform(Number)
    .pipe(z.number().int().positive())
    .default("30000"),
});

const parseEnv = () => {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error("❌ Invalid environment variables:");
    console.error(JSON.stringify(result.error.format(), null, 2));
    process.exit(1);
  }

  return result.data;
};

let env = parseEnv();

const buildConfig = () =>
  ({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    corsOrigin: env.CORS_ORIGIN,

    db: {
      url: env.DATABASE_URL,
      host: env.DB_HOST,
      port: env.DB_PORT,
      name: env.DB_NAME,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      poolMin: env.DB_POOL_MIN,
      poolMax: env.DB_POOL_MAX,
    },

    provider: {
      baseUrl: env.PROVIDER_BASE_URL,
      timeoutMs: env.PROVIDER_TIMEOUT_MS,
    },

    webhook: {
      secret: env.WEBHOOK_SECRET,
    },

    idempotency: {
      keyTtlHours: env.IDEMPOTENCY_KEY_TTL_HOURS,
      staleLockThresholdMs: env.STALE_LOCK_THRESHOLD_MS,
    },
  }) as const;

export let config = buildConfig();

/**
 * Re-read process.env and rebuild the config object.
 * Used in integration tests where each test file sets different
 * DB_HOST / DB_PORT env vars for its own Testcontainers instance.
 */
export const reloadConfig = (): void => {
  env = parseEnv();
  config = buildConfig();
};
