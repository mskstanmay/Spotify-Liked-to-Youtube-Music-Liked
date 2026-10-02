const { webConfig, validateConfig } = require('../api/config');
const { getPrisma } = require('../api/db');
const { MigrationWorker } = require('./migrationWorker');

async function main() {
  const config = webConfig();
  validateConfig(config, { worker: true });
  const prisma = getPrisma();
  const worker = new MigrationWorker({ prisma, config });
  const running = worker.start();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    worker.stop();
    await running;
    await prisma.workerRuntime.deleteMany({ where: { id: worker.id } });
    await prisma.$disconnect();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdout.write(`[worker] ${worker.id} ready\n`);
  await running;
}

main().catch((error) => {
  process.stderr.write(`[worker] failed: ${error.message}\n`);
  process.exitCode = 1;
});
