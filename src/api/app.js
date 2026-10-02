const path = require('node:path');
const Fastify = require('fastify');
const { LogController } = require('fastify');
const cookie = require('@fastify/cookie');
const cors = require('@fastify/cors');
const helmet = require('@fastify/helmet');
const rateLimit = require('@fastify/rate-limit');
const staticPlugin = require('@fastify/static');
const { sessionGuards } = require('../auth/session');
const { registerAuthRoutes } = require('../auth/routes');
const { registerMigrationRoutes } = require('../migration/routes');
const { validateConfig } = require('./config');

async function buildApp({ prisma, config, logger = config.nodeEnv !== 'test' } = {}) {
  const secureDeployment = config.secureDeployment ?? config.nodeEnv === 'production';
  const app = Fastify({
    logger,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: secureDeployment,
    bodyLimit: 32 * 1024,
  });
  await app.register(cookie, { secret: config.sessionSecret, hook: 'onRequest' });
  await app.register(cors, { origin: config.webBaseUrl, credentials: true, methods: ['GET', 'POST', 'DELETE'] });
  await app.register(helmet, { contentSecurityPolicy: secureDeployment });
  await app.register(rateLimit, { max: config.nodeEnv === 'test' ? 1000 : 180, timeWindow: '1 minute' });

  const guards = sessionGuards(prisma, config);
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/ready', async (request, reply) => {
    const checks = { configuration: false, database: false, worker: !config.requireWorkerReady };
    try {
      validateConfig(config);
      checks.configuration = true;
    } catch {
      return reply.code(503).send({ ok: false, checks });
    }
    try {
      await prisma.$queryRawUnsafe('SELECT 1');
      checks.database = true;
      if (config.requireWorkerReady) {
        const cutoff = new Date(Date.now() - config.workerReadyMaxAgeMs);
        checks.worker = Boolean(await prisma.workerRuntime.findFirst({ where: { updatedAt: { gt: cutoff } }, select: { id: true } }));
      }
    } catch {
      return reply.code(503).send({ ok: false, checks });
    }
    return reply.code(checks.worker ? 200 : 503).send({ ok: checks.worker, checks });
  });
  registerAuthRoutes(app, { prisma, config, guards });
  registerMigrationRoutes(app, { prisma, config, guards });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error, code: error.code }, 'request failed');
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    const code = error.code && status < 500 ? error.code : 'INTERNAL_ERROR';
    const message = status < 500 ? error.message : 'Something went wrong. Please try again.';
    reply.code(status).send({ error: { code, message } });
  });

  const dist = path.join(config.rootDir, 'web', 'dist');
  if (secureDeployment) {
    await app.register(staticPlugin, { root: dist, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
      return reply.sendFile('index.html');
    });
  }
  return app;
}

module.exports = { buildApp };
