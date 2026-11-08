import type { Knex } from 'knex';
import { config } from './src/config.js';

const knexConfig: Knex.Config = {
  client: 'pg',
  connection: config.db.url ?? {
    host: config.db.host,
    port: config.db.port,
    database: config.db.name,
    user: config.db.user,
    password: config.db.password,
  },
  pool: {
    min: config.db.poolMin,
    max: config.db.poolMax,
  },
  migrations: {
    directory: './src/db/migrations',
    extension: 'ts',
    tableName: 'knex_migrations',
  },
  seeds: {
    directory: './src/db/seeds',
    extension: 'ts',
  },
};

export default knexConfig;
