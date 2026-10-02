const test = require('node:test');
const assert = require('node:assert/strict');
const { buildApp } = require('../src/api/app');
const { csrfToken, hashToken } = require('../src/auth/security');

const config = {
  nodeEnv: 'test', rootDir: process.cwd(), webBaseUrl: 'http://127.0.0.1:5173', apiBaseUrl: 'http://127.0.0.1:3000',
  sessionSecret: 'm'.repeat(48), sessionCookieName: 'musicmove_session', sessionDays: 30,
  tokenEncryptionKey: Buffer.alloc(32, 4).toString('base64'),
  spotify: { clientId: 'spotify', redirectUri: 'http://127.0.0.1/callback', scope: 'user-library-read user-read-private' },
  google: { clientId: 'google', clientSecret: 'secret', redirectUri: 'http://127.0.0.1/callback', scopes: ['openid', 'profile', 'https://www.googleapis.com/auth/youtube.force-ssl'] },
};

function fieldMatches(value, condition) {
  if (condition === undefined) return true;
  if (condition === null || typeof condition !== 'object') return value === condition;
  if (condition.in && !condition.in.includes(value)) return false;
  if (Object.hasOwn(condition, 'not') && value === condition.not) return false;
  return true;
}

function rowMatches(row, where = {}) {
  return Object.entries(where).every(([key, condition]) => fieldMatches(row[key], condition));
}

function applyData(row, data) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && Object.hasOwn(value, 'increment')) row[key] += value.increment;
    else row[key] = value;
  }
}

async function stateApp({ status = 'PAUSED', phase = 'SCANNING', tracks = [], failMigrationUpdate = false } = {}) {
  let migration = {
    id: 'migration', userId: 'user', source: 'spotify', destination: 'youtube_music', status, phase,
    leaseVersion: 2, workerId: null, lockedUntil: null, totalTracks: tracks.length, processedTracks: 0,
    confidentCount: 0, likedCount: 0, alreadyLikedCount: 0, reviewCount: tracks.filter((row) => row.status === 'REVIEW').length,
    notFoundCount: 0, failedCount: tracks.filter((row) => row.status === 'FAILED').length, skippedCount: 0,
    currentTrackTitle: null, currentTrackArtist: null, lastErrorCode: null, lastErrorMessage: null,
    startedAt: null, completedAt: status === 'COMPLETED' ? new Date() : null, createdAt: new Date(), updatedAt: new Date(),
  };
  let trackRows = tracks.map((row, index) => ({
    id: `track-${index + 1}`, migrationId: 'migration', position: index + 1, spotifyTrackId: `spotify-${index + 1}`,
    spotifyTitle: 'Song', spotifyArtists: ['Artist'], matchedYoutubeVideoId: null, matchedYoutubeArtists: [], ...row,
  }));
  const candidates = [{ id: 'candidate', trackId: trackRows[0]?.id, videoId: 'video', title: 'Video', artists: ['Artist'], score: .95 }];
  let txTail = Promise.resolve();
  const prisma = {
    appSession: { findFirst: async ({ where }) => where.tokenHash === hashToken('token') ? { id: 'session', userId: 'user', expiresAt: new Date(Date.now() + 60000), user: { id: 'user', createdAt: new Date() } } : null },
    spotifyConnection: { findUnique: async () => ({ id: 'spotify' }) },
    youTubeConnection: { findUnique: async () => ({ id: 'youtube' }) },
    migration: {
      findFirst: async ({ where }) => rowMatches(migration, where) ? { ...migration } : null,
      findUnique: async () => ({ ...migration }),
      findMany: async () => [{ ...migration }],
      updateMany: async ({ where, data }) => { if (!rowMatches(migration, where)) return { count: 0 }; applyData(migration, data); return { count: 1 }; },
      update: async ({ data }) => { if (failMigrationUpdate) throw new Error('injected update failure'); applyData(migration, data); return { ...migration }; },
    },
    migrationTrack: {
      findFirst: async ({ where }) => trackRows.find((row) => rowMatches(row, where)) || null,
      findMany: async () => trackRows.map((row) => ({ ...row })),
      count: async ({ where }) => trackRows.filter((row) => rowMatches(row, where)).length,
      groupBy: async () => Object.entries(trackRows.reduce((groups, row) => ({ ...groups, [row.status]: (groups[row.status] || 0) + 1 }), {})).map(([trackStatus, count]) => ({ status: trackStatus, _count: { _all: count } })),
      updateMany: async ({ where, data }) => { const selected = trackRows.filter((row) => rowMatches(row, where)); selected.forEach((row) => applyData(row, data)); return { count: selected.length }; },
    },
    migrationCandidate: { findFirst: async ({ where }) => candidates.find((row) => rowMatches(row, where)) || null },
  };
  prisma.$transaction = (callback) => {
    const run = txTail.then(async () => {
      const migrationSnapshot = structuredClone(migration);
      const tracksSnapshot = structuredClone(trackRows);
      try { return await callback(prisma); } catch (error) { migration = migrationSnapshot; trackRows = tracksSnapshot; throw error; }
    });
    txTail = run.catch(() => {});
    return run;
  };
  const app = await buildApp({ prisma, config, logger: false });
  const cookie = `${config.sessionCookieName}=${app.signCookie('token')}`;
  const headers = { cookie, 'x-csrf-token': csrfToken('session', config.sessionSecret) };
  return { app, headers, get migration() { return migration; }, get tracks() { return trackRows; } };
}

for (const scenario of [
  { name: 'before any track rows exist', tracks: [] },
  { name: 'after some track rows exist', tracks: [{ status: 'PENDING' }] },
  { name: 'after scan authentication failure', tracks: [], status: 'AUTHENTICATION_REQUIRED' },
  { name: 'after scan provider failure', tracks: [], status: 'FAILED' },
]) {
  test(`resume returns to scanning ${scenario.name}`, async () => {
    const store = await stateApp({ status: scenario.status || 'PAUSED', phase: 'SCANNING', tracks: scenario.tracks });
    try {
      const response = await store.app.inject({ method: 'POST', url: '/api/migrations/migration/resume', headers: store.headers });
      assert.equal(response.statusCode, 202);
      assert.equal(store.migration.status, 'SCANNING');
      assert.equal(store.migration.phase, 'SCANNING');
    } finally { await store.app.close(); }
  });
}

for (const status of ['PAUSED', 'AUTHENTICATION_REQUIRED', 'QUOTA_PAUSED', 'FAILED']) {
  test(`liking phase resumes from ${status} into the queue`, async () => {
    const store = await stateApp({ status, phase: 'LIKING', tracks: [{ status: 'READY', matchedYoutubeVideoId: 'video' }] });
    try {
      const response = await store.app.inject({ method: 'POST', url: '/api/migrations/migration/resume', headers: store.headers });
      assert.equal(response.statusCode, 202);
      assert.equal(store.migration.status, 'QUEUED');
      assert.equal(store.migration.phase, 'LIKING');
    } finally { await store.app.close(); }
  });
}

test('start accepts only a completed scan in READY/LIKING', async () => {
  const interrupted = await stateApp({ status: 'AUTHENTICATION_REQUIRED', phase: 'SCANNING' });
  try {
    const rejected = await interrupted.app.inject({ method: 'POST', url: '/api/migrations/migration/start', headers: interrupted.headers });
    assert.equal(rejected.statusCode, 409);
  } finally { await interrupted.app.close(); }
  const ready = await stateApp({ status: 'READY', phase: 'LIKING', tracks: [{ status: 'READY', matchedYoutubeVideoId: 'video' }] });
  try {
    const accepted = await ready.app.inject({ method: 'POST', url: '/api/migrations/migration/start', headers: ready.headers });
    assert.equal(accepted.statusCode, 202);
    assert.equal(ready.migration.status, 'QUEUED');
  } finally { await ready.app.close(); }
});

test('two concurrent candidate selections produce exactly one transition and exact counters', async () => {
  const store = await stateApp({ status: 'COMPLETED', phase: 'LIKING', tracks: [{ status: 'REVIEW' }] });
  try {
    const request = () => store.app.inject({ method: 'POST', url: '/api/migrations/migration/reviews/track-1/choose', headers: store.headers, payload: { candidateId: 'candidate' } });
    const responses = await Promise.all([request(), request()]);
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [202, 409]);
    assert.equal(store.migration.reviewCount, 0);
    assert.equal(store.migration.confidentCount, 1);
    assert.equal(store.migration.status, 'QUEUED');
  } finally { await store.app.close(); }
});

test('choose racing with skip results in exactly one valid transition', async () => {
  const store = await stateApp({ status: 'COMPLETED', phase: 'LIKING', tracks: [{ status: 'REVIEW' }] });
  try {
    const [choose, skip] = await Promise.all([
      store.app.inject({ method: 'POST', url: '/api/migrations/migration/reviews/track-1/choose', headers: store.headers, payload: { candidateId: 'candidate' } }),
      store.app.inject({ method: 'POST', url: '/api/migrations/migration/reviews/track-1/skip', headers: store.headers }),
    ]);
    assert.equal([choose, skip].filter((response) => response.statusCode < 300).length, 1);
    assert.equal(store.migration.reviewCount, 0);
    assert.ok(store.migration.confidentCount + store.migration.skippedCount === 1);
  } finally { await store.app.close(); }
});

test('two skips cannot decrement a review counter twice or below zero', async () => {
  const store = await stateApp({ status: 'COMPLETED', phase: 'LIKING', tracks: [{ status: 'REVIEW' }] });
  try {
    const request = () => store.app.inject({ method: 'POST', url: '/api/migrations/migration/reviews/track-1/skip', headers: store.headers });
    const responses = await Promise.all([request(), request()]);
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
    assert.equal(store.migration.reviewCount, 0);
    assert.equal(store.migration.skippedCount, 1);
  } finally { await store.app.close(); }
});

test('retry cannot race an active worker and a second retry is rejected', async () => {
  const active = await stateApp({ status: 'RUNNING', phase: 'LIKING', tracks: [{ status: 'FAILED', matchedYoutubeVideoId: 'video' }] });
  try {
    const response = await active.app.inject({ method: 'POST', url: '/api/migrations/migration/retry', headers: active.headers });
    assert.equal(response.statusCode, 409);
    assert.equal(active.tracks[0].status, 'FAILED');
  } finally { await active.app.close(); }
  const terminal = await stateApp({ status: 'COMPLETED', phase: 'LIKING', tracks: [{ status: 'FAILED', matchedYoutubeVideoId: 'video' }] });
  try {
    const first = await terminal.app.inject({ method: 'POST', url: '/api/migrations/migration/retry', headers: terminal.headers });
    const second = await terminal.app.inject({ method: 'POST', url: '/api/migrations/migration/retry', headers: terminal.headers });
    assert.equal(first.statusCode, 202);
    assert.equal(second.statusCode, 409);
  } finally { await terminal.app.close(); }
});

test('a failed review transaction leaves track, counters, and migration status unchanged', async () => {
  const store = await stateApp({ status: 'COMPLETED', phase: 'LIKING', tracks: [{ status: 'REVIEW' }], failMigrationUpdate: true });
  try {
    const response = await store.app.inject({ method: 'POST', url: '/api/migrations/migration/reviews/track-1/choose', headers: store.headers, payload: { candidateId: 'candidate' } });
    assert.equal(response.statusCode, 500);
    assert.equal(store.tracks[0].status, 'REVIEW');
    assert.equal(store.migration.reviewCount, 1);
    assert.equal(store.migration.status, 'COMPLETED');
  } finally { await store.app.close(); }
});
