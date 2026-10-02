const test = require('node:test');
const assert = require('node:assert/strict');
const { MigrationWorker, LeaseLostError } = require('../src/worker/migrationWorker');
const { updateOwnedMigration } = require('../src/migration/routes');

function matches(value, condition) {
  if (condition === undefined) return true;
  if (condition === null || typeof condition !== 'object' || condition instanceof Date) return value === condition;
  if (condition.in && !condition.in.includes(value)) return false;
  if (condition.gt && !(value && value > condition.gt)) return false;
  if (condition.lt && !(value && value < condition.lt)) return false;
  return true;
}

function matchesWhere(row, where) {
  if (!where) return true;
  if (where.AND && !where.AND.every((entry) => matchesWhere(row, entry))) return false;
  if (where.OR && !where.OR.some((entry) => matchesWhere(row, entry))) return false;
  return Object.entries(where).every(([key, condition]) => ['AND', 'OR'].includes(key) || matches(row[key], condition));
}

function applyData(row, data) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && Object.hasOwn(value, 'increment')) row[key] += value.increment;
    else row[key] = value;
  }
  row.updatedAt = new Date();
}

function memoryPrisma(overrides = {}) {
  const row = {
    id: 'migration', userId: 'user', status: 'RUNNING', phase: 'LIKING', leaseVersion: 0,
    workerId: null, lockedUntil: null, updatedAt: new Date(0), ...overrides,
  };
  const migration = {
    findFirst: async ({ where }) => matchesWhere(row, where) ? { ...row } : null,
    findUnique: async () => ({ ...row }),
    updateMany: async ({ where, data }) => {
      if (!matchesWhere(row, where)) return { count: 0 };
      applyData(row, data);
      return { count: 1 };
    },
    update: async ({ data }) => { applyData(row, data); return { ...row }; },
  };
  const prisma = { migration };
  prisma.$transaction = async (callback) => callback(prisma);
  return { prisma, row };
}

function worker(prisma, id, workerLeaseMs = 1000) {
  return new MigrationWorker({ prisma, id, config: { workerLeaseMs }, logger: { error() {} } });
}

test('two workers attempting to claim the same migration produce one owner', async () => {
  const store = memoryPrisma();
  const workerA = worker(store.prisma, 'worker-a');
  const workerB = worker(store.prisma, 'worker-b');
  const claims = await Promise.all([workerA.claim(), workerB.claim()]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(store.row.leaseVersion, 1);
  assert.ok(['worker-a', 'worker-b'].includes(store.row.workerId));
});

test('worker A loses an expired lease, worker B takes over, and A cannot persist', async () => {
  const store = memoryPrisma();
  const workerA = worker(store.prisma, 'worker-a');
  const workerB = worker(store.prisma, 'worker-b');
  const jobA = await workerA.claim();
  store.row.lockedUntil = new Date(0);
  const jobB = await workerB.claim();
  assert.equal(jobB.workerId, 'worker-b');
  assert.equal(jobB.leaseVersion, jobA.leaseVersion + 1);
  await assert.rejects(() => workerA.updateMigration(jobA, ['RUNNING'], { currentTrackTitle: 'stale write' }), LeaseLostError);
  assert.notEqual(store.row.currentTrackTitle, 'stale write');
});

test('pause invalidates an active worker and resume allocates a new fence', async () => {
  const store = memoryPrisma();
  const workerA = worker(store.prisma, 'worker-a');
  const jobA = await workerA.claim();
  const active = { ...store.row };
  const paused = await updateOwnedMigration(store.prisma, active, 'user', { status: 'PAUSED', workerId: null, leaseVersion: { increment: 1 } });
  assert.equal(paused.status, 'PAUSED');
  await assert.rejects(() => workerA.updateMigration(jobA, ['RUNNING'], { likedCount: 99 }), LeaseLostError);
  const resumed = await updateOwnedMigration(store.prisma, paused, 'user', { status: 'QUEUED', workerId: null, leaseVersion: { increment: 1 } });
  assert.equal(resumed.status, 'QUEUED');
  assert.equal(await worker(store.prisma, 'worker-b').claim(), null);
  store.row.lockedUntil = new Date(0);
  const jobB = await worker(store.prisma, 'worker-b').claim();
  assert.equal(jobB.workerId, 'worker-b');
  assert.equal(store.row.likedCount, undefined);
});

test('heartbeat renews the database lease throughout a long operation', async () => {
  const store = memoryPrisma();
  const workerA = worker(store.prisma, 'worker-a', 45);
  const jobA = await workerA.claim();
  const initialDeadline = store.row.lockedUntil;
  const stop = workerA.startHeartbeat(jobA);
  await new Promise((resolve) => setTimeout(resolve, 110));
  assert.ok(store.row.lockedUntil > initialDeadline);
  assert.equal(await worker(store.prisma, 'worker-b', 45).claim(), null);
  await stop();
});

test('a database heartbeat error is fail-closed and marks the lease lost', async () => {
  const store = memoryPrisma();
  const activeWorker = worker(store.prisma, 'worker-a');
  const job = await activeWorker.claim();
  store.prisma.migration.updateMany = async () => { throw new Error('database unavailable'); };
  await assert.rejects(() => activeWorker.heartbeat(job), /database unavailable/);
  assert.equal(job.leaseLost, true);
});

test('a stale fence prevents status, counter, and result callbacks from running', async () => {
  const store = memoryPrisma();
  const workerA = worker(store.prisma, 'worker-a');
  const jobA = await workerA.claim();
  store.row.leaseVersion += 1;
  store.row.workerId = 'worker-b';
  let wroteResult = false;
  await assert.rejects(
    () => workerA.fencedTransaction(jobA, ['RUNNING'], async () => { wroteResult = true; store.row.status = 'COMPLETED'; store.row.likedCount = 1; }),
    LeaseLostError,
  );
  assert.equal(wroteResult, false);
  assert.equal(store.row.status, 'RUNNING');
  assert.equal(store.row.likedCount, undefined);
});

test('liking cannot complete until every required track is terminal', async () => {
  const store = memoryPrisma();
  let trackStatus = 'READY';
  store.prisma.migrationTrack = {
    groupBy: async () => [{ status: trackStatus, _count: { _all: 1 } }],
    count: async ({ where }) => where.matchedYoutubeVideoId ? 1 : (where.status.in.includes(trackStatus) ? 1 : 0),
  };
  const activeWorker = worker(store.prisma, 'worker-a');
  const job = await activeWorker.claim();
  assert.equal(await activeWorker.completeIfFinished(job), false);
  assert.equal(store.row.status, 'RUNNING');
  trackStatus = 'LIKED';
  assert.equal(await activeWorker.completeIfFinished(job), true);
  assert.equal(store.row.status, 'COMPLETED');
});
