const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MigrationWorker,
  LeaseLostError,
  SPOTIFY_TRACK_BATCH_SIZE,
  spotifyFetchComplete,
} = require('../src/worker/migrationWorker');

function tracks(count) {
  return Array.from({ length: count }, (_, index) => ({
    spotifyTrackId: `spotify-${index + 1}`,
    title: `Song ${index + 1}`,
    artists: ['Artist'],
    album: 'Album',
    durationMs: 180000 + index,
    spotifyUrl: `https://open.spotify.com/track/${index + 1}`,
  }));
}

function persistenceStore(options = {}) {
  let migration = {
    id: 'migration', status: 'SCANNING', phase: 'SCANNING', workerId: 'worker-a',
    leaseVersion: 1, lockedUntil: new Date(Date.now() + 60_000),
    totalTracks: 0, sourceTotalTracks: null,
  };
  let persisted = new Map();
  let transactionCount = 0;
  let insertCount = 0;
  const batchSizes = [];

  const prisma = {
    $transaction: async (callback) => {
      transactionCount += 1;
      options.beforeTransaction?.({ transactionCount, migration });
      const localMigration = { ...migration };
      const localPersisted = new Map([...persisted].map(([key, value]) => [key, { ...value }]));
      const tx = {
        migration: {
          updateMany: async ({ where, data }) => {
            const owned = localMigration.id === where.id
              && localMigration.workerId === where.workerId
              && localMigration.leaseVersion === where.leaseVersion
              && where.status.in.includes(localMigration.status)
              && localMigration.lockedUntil > where.lockedUntil.gt;
            if (!owned) return { count: 0 };
            Object.assign(localMigration, data);
            return { count: 1 };
          },
          update: async ({ data }) => {
            Object.assign(localMigration, data);
            return { ...localMigration };
          },
        },
        migrationTrack: {
          createMany: async ({ data }) => {
            insertCount += 1;
            batchSizes.push(data.length);
            if (options.failInsert?.(insertCount)) throw new Error('simulated batch failure');
            for (const row of data) {
              const key = `${row.migrationId}:${row.spotifyTrackId}`;
              if (!localPersisted.has(key)) localPersisted.set(key, { ...row, status: 'PENDING' });
            }
            options.afterInsert?.({ insertCount, data });
            return { count: data.length };
          },
          count: async ({ where }) => [...localPersisted.values()]
            .filter((row) => row.migrationId === where.migrationId).length,
        },
      };
      const result = await callback(tx);
      migration = localMigration;
      persisted = localPersisted;
      return result;
    },
  };

  return {
    prisma,
    get migration() { return migration; },
    get persisted() { return [...persisted.values()]; },
    get transactionCount() { return transactionCount; },
    get insertCount() { return insertCount; },
    batchSizes,
  };
}

function worker(store) {
  return new MigrationWorker({
    prisma: store.prisma,
    id: 'worker-a',
    config: { workerLeaseMs: 60_000 },
    logger: { info() {}, warn() {}, error() {} },
  });
}

function job(store) {
  return { ...store.migration, leaseLost: false };
}

test('one Spotify track persists with the existing migration semantics', async () => {
  const store = persistenceStore();
  const activeJob = job(store);
  assert.equal(await worker(store).persistSpotifyTracks(activeJob, tracks(1), 1), 1);
  assert.deepEqual(store.batchSizes, [1]);
  assert.equal(store.persisted.length, 1);
  assert.equal(store.migration.totalTracks, 1);
  assert.equal(store.migration.sourceTotalTracks, 1);
  assert.equal(store.migration.phase, 'SCANNING');
});

test('a small Spotify library uses one bounded insertion batch', async () => {
  const store = persistenceStore();
  assert.equal(await worker(store).persistSpotifyTracks(job(store), tracks(25), 25), 25);
  assert.deepEqual(store.batchSizes, [25]);
  assert.equal(store.transactionCount, 2);
});

test('a 1901-track library is persisted in bounded transactions with an exact final count', async () => {
  const store = persistenceStore();
  const activeJob = job(store);
  const count = await worker(store).persistSpotifyTracks(activeJob, tracks(1901), 1901);
  assert.equal(count, 1901);
  assert.equal(store.persisted.length, 1901);
  assert.deepEqual(store.batchSizes, [200, 200, 200, 200, 200, 200, 200, 200, 200, 101]);
  assert.equal(store.transactionCount, Math.ceil(1901 / SPOTIFY_TRACK_BATCH_SIZE) + 1);
  assert.equal(store.migration.totalTracks, 1901);
  assert.equal(store.migration.sourceTotalTracks, 1901);
  assert.equal(store.migration.status, 'SCANNING');
  assert.equal(store.migration.phase, 'SCANNING');
  assert.equal(spotifyFetchComplete(activeJob, 1901), true);
});

test('a mid-persistence failure is recoverable without duplicate tracks', async () => {
  let shouldFail = true;
  const store = persistenceStore({
    failInsert: (insertCount) => shouldFail && insertCount === 3,
  });
  const activeJob = job(store);
  await assert.rejects(
    () => worker(store).persistSpotifyTracks(activeJob, tracks(1901), 1901),
    /simulated batch failure/,
  );
  assert.equal(store.persisted.length, 400);
  assert.equal(store.migration.sourceTotalTracks, null);
  assert.equal(store.migration.phase, 'SCANNING');
  assert.equal(spotifyFetchComplete(activeJob, store.persisted.length), false);

  shouldFail = false;
  assert.equal(await worker(store).persistSpotifyTracks(activeJob, tracks(1901), 1901), 1901);
  assert.equal(store.persisted.length, 1901);
  assert.equal(new Set(store.persisted.map((track) => track.spotifyTrackId)).size, 1901);
  assert.equal(store.migration.sourceTotalTracks, 1901);
});

test('lease loss between batches prevents the next batch from mutating', async () => {
  const store = persistenceStore({
    beforeTransaction: ({ transactionCount, migration }) => {
      if (transactionCount === 3) {
        migration.workerId = 'worker-b';
        migration.leaseVersion += 1;
      }
    },
  });
  const activeJob = job(store);
  await assert.rejects(
    () => worker(store).persistSpotifyTracks(activeJob, tracks(450), 450),
    LeaseLostError,
  );
  assert.equal(activeJob.leaseLost, true);
  assert.equal(store.persisted.length, 400);
  assert.equal(store.migration.sourceTotalTracks, null);
  assert.equal(store.migration.phase, 'SCANNING');
});

test('lease loss during a batch rolls that batch back', async () => {
  let activeJob;
  const store = persistenceStore({
    afterInsert: ({ insertCount }) => {
      if (insertCount === 2) activeJob.leaseLost = true;
    },
  });
  activeJob = job(store);
  await assert.rejects(
    () => worker(store).persistSpotifyTracks(activeJob, tracks(450), 450),
    LeaseLostError,
  );
  assert.equal(store.persisted.length, 200);
  assert.equal(store.migration.sourceTotalTracks, null);
  assert.equal(store.migration.phase, 'SCANNING');
});
