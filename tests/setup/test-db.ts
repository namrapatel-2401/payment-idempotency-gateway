import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { Knex } from "knex";
import knex from "knex";
import { reloadConfig } from "../../src/config.js";
import { closeDb, resetDb } from "../../src/db/connection.js";

let container: StartedTestContainer | null = null;
let testDb: Knex | null = null;

export const startTestDatabase = async (): Promise<{
  container: StartedTestContainer;
  db: Knex;
  connectionConfig: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
}> => {
  // Start PostgreSQL container
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
      POSTGRES_DB: "payment_gateway_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/),
    )
    .withStartupTimeout(120000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);

  const connectionConfig = {
    host,
    port,
    database: "payment_gateway_test",
    user: "test",
    password: "test",
  };

  // The application config and database connection are module singletons.
  // Configure and reset them before any suite builds its Fastify app so the
  // app uses this container's dynamically mapped PostgreSQL port.
  process.env.DB_HOST = connectionConfig.host;
  process.env.DB_PORT = String(connectionConfig.port);
  process.env.DB_NAME = connectionConfig.database;
  process.env.DB_USER = connectionConfig.user;
  process.env.DB_PASSWORD = connectionConfig.password;
  reloadConfig();
  await resetDb();

  // Create Knex instance
  testDb = knex({
    client: "pg",
    connection: connectionConfig,
    pool: { min: 2, max: 10 },
  });

  // Run migrations
  await testDb.migrate.latest({
    directory: "./src/db/migrations",
  });

  return { container, db: testDb, connectionConfig };
};

export const stopTestDatabase = async (): Promise<void> => {
  // Close the application's pool before stopping the container that owns it.
  // This is idempotent and also makes teardown safe for suites that do not
  // explicitly close the application singleton themselves.
  await closeDb();

  if (testDb) {
    await testDb.destroy();
    testDb = null;
  }

  if (container) {
    await container.stop();
    container = null;
  }
};

export const cleanTestData = async (db: Knex): Promise<void> => {
  await db("provider_correlation_conflicts").del();
  await db("provider_conflicts").del();
  await db("webhook_delivery_conflicts").del();
  await db("payment_events").del();
  await db("payments").del();
  await db("idempotency_keys").del();
  await db("orphaned_webhooks").del();
  await db("webhook_deliveries").del();
};
