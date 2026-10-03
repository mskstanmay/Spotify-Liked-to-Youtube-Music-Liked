const { getPrisma } = require('../api/db');
const { createNativeSearch } = require('../ytmusic/nativeSearch');
const { MigrationWorker } = require('./migrationWorker');
const { nativeWorkerConfig, validateNativeWorkerConfig } = require('./nativeConfig');

async function main() {
  const config = nativeWorkerConfig();
  validateNativeWorkerConfig(config);
  const prisma = getPrisma();
  const searchTrack = createNativeSearch({
    limit: config.ytmusicSearchLimit,
    timeoutMs: config.ytmusicSearchTimeoutMs,
  });
  const worker = new MigrationWorker({ prisma, config, providers: { searchTrack } });
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

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[worker] failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
