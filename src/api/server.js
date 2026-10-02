const { webConfig, validateConfig } = require('./config');
const { getPrisma } = require('./db');
const { buildApp } = require('./app');

async function main() {
  const config = webConfig();
  validateConfig(config);
  const prisma = getPrisma();
  const app = await buildApp({ prisma, config });
  const shutdown = async () => {
    await app.close();
    await prisma.$disconnect();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await app.listen({ port: config.port, host: config.host });
}

main().catch((error) => {
  process.stderr.write(`[api] failed: ${error.message}\n`);
  process.exitCode = 1;
});
