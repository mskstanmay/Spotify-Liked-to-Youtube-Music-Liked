const fs = require('node:fs');
const path = require('node:path');
const { webConfig, validateConfig } = require('../api/config');
const { getPrisma } = require('../api/db');

function expectedMigrations(rootDir) {
  const directory = path.join(rootDir, 'prisma', 'migrations');
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function appliedMigrations(prisma) {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL ORDER BY "migration_name"',
  );
  return rows.map((row) => row.migration_name);
}

async function runPreflight({ config, prisma, fetchImpl = fetch }) {
  const checks = [];
  const record = (name, ok, detail) => checks.push({ name, ok, ...(detail ? { detail } : {}) });

  try {
    validateConfig(config);
    if (config.appEnv !== 'staging') throw new Error('APP_ENV must be staging.');
    record('configuration', true);
  } catch {
    record('configuration', false, 'Staging environment or required configuration is invalid.');
  }

  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    record('database', true);
  } catch {
    record('database', false, 'Database connectivity failed.');
  }

  try {
    const expected = expectedMigrations(config.rootDir);
    const applied = await appliedMigrations(prisma);
    const missing = expected.filter((name) => !applied.includes(name));
    const unexpected = applied.filter((name) => !expected.includes(name));
    const exact = missing.length === 0 && unexpected.length === 0;
    const detail = exact
      ? `${applied.length} migration(s) applied.`
      : `Migration history mismatch: ${missing.length} missing, ${unexpected.length} unexpected.`;
    record('migrations', exact, detail);
  } catch {
    record('migrations', false, 'Prisma migration state could not be verified.');
  }

  try {
    const cutoff = new Date(Date.now() - config.workerReadyMaxAgeMs);
    const worker = await prisma.workerRuntime.findFirst({ where: { updatedAt: { gt: cutoff } }, select: { id: true } });
    record('worker', Boolean(worker), worker ? 'Recent worker heartbeat found.' : 'No recent worker heartbeat found.');
  } catch {
    record('worker', false, 'Worker readiness could not be verified.');
  }

  for (const endpoint of ['health', 'ready']) {
    try {
      const response = await fetchImpl(`${config.apiBaseUrl}/api/${endpoint}`, { signal: AbortSignal.timeout(5000) });
      const body = await response.json().catch(() => ({}));
      record(`api_${endpoint}`, response.ok && body.ok === true, response.ok && body.ok === true ? 'Endpoint is healthy.' : 'Endpoint reported unavailable.');
    } catch {
      record(`api_${endpoint}`, false, 'Endpoint could not be reached.');
    }
  }

  return { ok: checks.every((check) => check.ok), checks };
}

async function main() {
  const config = webConfig();
  const prisma = getPrisma();
  try {
    const result = await runPreflight({ config, prisma });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch(() => {
    process.stderr.write('[staging-preflight] failed without exposing configuration details.\n');
    process.exitCode = 1;
  });
}

module.exports = { expectedMigrations, appliedMigrations, runPreflight };
