import Fastify from 'fastify';
import { providerConfig } from './config.js';
import { chargeRoutes } from './routes/charge.js';
import { configRoutes } from './routes/config.js';
import { initDatabase } from './db.js';

export const buildProviderApp = async () => {
  const app = Fastify({
    logger: {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
    },
  });

  // Initialize in-memory database
  await initDatabase();

  // Register routes
  await app.register(chargeRoutes, { prefix: '/provider' });
  await app.register(configRoutes, { prefix: '/provider' });

  // Health check
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  return app;
};

const start = async () => {
  try {
    const app = await buildProviderApp();
    await app.listen({ port: providerConfig.port, host: '0.0.0.0' });
    app.log.info(`Payment Provider running on port ${providerConfig.port}`);
    app.log.info(`Config: failureRate=${providerConfig.failureRate}, timeoutRate=${providerConfig.timeoutRate}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}
