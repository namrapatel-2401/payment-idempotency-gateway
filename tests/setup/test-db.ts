import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { Knex } from "knex";
import knex from "knex";

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
  await db("payment_events").del();
  await db("payments").del();
  await db("idempotency_keys").del();
  await db("orphaned_webhooks").del();
  await db("webhook_deliveries").del();
};
