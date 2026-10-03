const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const { MigrationWorker, LeaseLostError } = require('../../src/worker/migrationWorker');
const { buildApp } = require('../../src/api/app');
const { hashToken, csrfToken } = require('../../src/auth/security');
const { tryClaimVideoLike, completeVideoLike } = require('../../src/worker/videoLikeCoordinator');
const { countMigrationTracks } = require('../../src/migration/state');
const { migrationJson } = require('../../src/migration/serialize');

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const integration = enabled ? test : test.skip;
let prisma;

function assertDedicatedTestDatabase(url) {
  const parsed = new URL(url);
  const databaseName = parsed.pathname.slice(1).toLowerCase();
  if (!databaseName.includes('test')) {
    throw new Error('TEST_DATABASE_URL must name a dedicated database containing "test" because the integration suite deletes its rows.');
  }
}

async function cleanDatabase() {
  await prisma.oAuthState.deleteMany();
  await prisma.user.deleteMany();
  await prisma.workerRuntime.deleteMany();
}

async function createUser() {
  return prisma.user.create({ data: {} });
}

async function createMigration(userId, data = {}) {
  return prisma.migration.create({ data: { userId, status: 'RUNNING', phase: 'LIKING', ...data } });
}

function worker(id, lease = 1000) {
  return new MigrationWorker({ prisma, id, config: { workerLeaseMs: lease }, logger: { error() {} } });
}

if (enabled) {
  test.before(async () => {
    assertDedicatedTestDatabase(databaseUrl);
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    execFileSync(npx, ['prisma', 'migrate', 'deploy'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    });
    prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    await prisma.$connect();
  });
  test.beforeEach(cleanDatabase);
  test.after(async () => prisma?.$disconnect());
}

integration('Prisma migrations apply and explicit phase/fence columns are usable', async () => {
  const user = await createUser();
  const migration = await createMigration(user.id, { status: 'SCANNING', phase: 'SCANNING', trackLimit: 3, sourceTotalTracks: 120 });
  assert.equal(migration.phase, 'SCANNING');
  assert.equal(migration.leaseVersion, 0);
  assert.equal(migration.trackLimit, 3);
  assert.equal(migration.sourceTotalTracks, 120);
  const track = await prisma.migrationTrack.create({ data: { migrationId: migration.id, position: 1, spotifyTrackId: 'schema-track', spotifyTitle: 'Song', spotifyArtists: ['Artist'] } });
  assert.equal(track.needsReview, false);
});

integration('PostgreSQL persists a full-library Spotify snapshot in fenced batches', async () => {
  const user = await createUser();
  const migration = await createMigration(user.id, {
    status: 'SCANNING', phase: 'SCANNING', workerId: 'worker-a', leaseVersion: 1,
    lockedUntil: new Date(Date.now() + 60_000), sourceTotalTracks: null, totalTracks: 0,
  });
  const sourceTracks = Array.from({ length: 1901 }, (_, index) => ({
    spotifyTrackId: `spotify-${index + 1}`,
    title: `Song ${index + 1}`,
    artists: ['Artist'],
    album: 'Album',
    durationMs: 180000 + index,
    spotifyUrl: `https://open.spotify.com/track/${index + 1}`,
  }));
  const activeWorker = worker('worker-a', 60_000);
  const count = await activeWorker.persistSpotifyTracks({ ...migration, leaseLost: false }, sourceTracks, 1901);
  assert.equal(count, 1901);
  assert.equal(await prisma.migrationTrack.count({ where: { migrationId: migration.id } }), 1901);
  const updated = await prisma.migration.findUnique({ where: { id: migration.id } });
  assert.equal(updated.totalTracks, 1901);
  assert.equal(updated.sourceTotalTracks, 1901);
  assert.equal(updated.status, 'SCANNING');
  assert.equal(updated.phase, 'SCANNING');
});

integration('PostgreSQL derives added-review counters from track flags without migration columns', async () => {
  const user = await createUser();
  const migration = await createMigration(user.id, { status: 'COMPLETED' });
  await prisma.migrationTrack.createMany({ data: [
    { migrationId: migration.id, position: 1, spotifyTrackId: 'high', spotifyTitle: 'High', spotifyArtists: ['Artist'], status: 'LIKED', needsReview: false, matchedYoutubeVideoId: 'video-high' },
    { migrationId: migration.id, position: 2, spotifyTrackId: 'medium', spotifyTitle: 'Medium', spotifyArtists: ['Artist'], status: 'LIKED', needsReview: true, matchedYoutubeVideoId: 'video-medium' },
    { migrationId: migration.id, position: 3, spotifyTrackId: 'existing', spotifyTitle: 'Existing', spotifyArtists: ['Artist'], status: 'ALREADY_LIKED', needsReview: true, matchedYoutubeVideoId: 'video-existing' },
  ] });
  const counts = await countMigrationTracks(prisma, migration.id, 'LIKING');
  const serialized = migrationJson({ ...migration, likedCount: counts.likedCount, alreadyLikedCount: counts.alreadyLikedCount }, counts);
  assert.equal(counts.addedReviewCount, 1);
  assert.equal(counts.needsReviewCount, 2);
  assert.equal(serialized.addedCount, 1);
  assert.equal(serialized.addedReviewCount, 1);
  assert.equal(serialized.alreadyLikedCount, 1);
});

integration('PostgreSQL permits only one concurrent worker claim', async () => {
  const user = await createUser();
  await createMigration(user.id);
  const claims = await Promise.all([worker('worker-a').claim(), worker('worker-b').claim()]);
  assert.equal(claims.filter(Boolean).length, 1);
  const row = await prisma.migration.findFirst();
  assert.equal(row.leaseVersion, 1);
});

integration('expired lease takeover fences every stale worker write', async () => {
  const user = await createUser();
  await createMigration(user.id);
  const workerA = worker('worker-a');
  const jobA = await workerA.claim();
  await prisma.migration.update({ where: { id: jobA.id }, data: { lockedUntil: new Date(0) } });
  const jobB = await worker('worker-b').claim();
  assert.ok(jobB);
  await assert.rejects(() => workerA.updateMigration(jobA, ['RUNNING'], { likedCount: 99, status: 'COMPLETED' }), LeaseLostError);
  const row = await prisma.migration.findUnique({ where: { id: jobA.id } });
  assert.equal(row.workerId, 'worker-b');
  assert.notEqual(row.status, 'COMPLETED');
  assert.equal(row.likedCount, 0);
});

async function authenticatedApp(userId) {
  const localConfig = {
    nodeEnv: 'test', rootDir: process.cwd(), webBaseUrl: 'http://127.0.0.1:5173', apiBaseUrl: 'http://127.0.0.1:3000',
    sessionSecret: 'i'.repeat(48), sessionCookieName: 'musicmove_session', sessionDays: 1,
    tokenEncryptionKey: Buffer.alloc(32, 2).toString('base64'),
    spotify: { clientId: 'spotify', redirectUri: 'http://127.0.0.1/callback', scope: 'user-library-read user-read-private' },
    google: { clientId: 'google', clientSecret: 'secret', redirectUri: 'http://127.0.0.1/callback', scopes: ['openid', 'profile', 'https://www.googleapis.com/auth/youtube.force-ssl'] },
  };
  await prisma.appSession.create({ data: { userId, tokenHash: hashToken('integration-token'), expiresAt: new Date(Date.now() + 60_000) } });
  const app = await buildApp({ prisma, config: localConfig, logger: false });
  const session = await prisma.appSession.findUnique({ where: { tokenHash: hashToken('integration-token') } });
  return {
    app,
    headers: {
      cookie: `${localConfig.sessionCookieName}=${app.signCookie('integration-token')}`,
      'x-csrf-token': csrfToken(session.id, localConfig.sessionSecret),
    },
  };
}

async function reviewFixture() {
  const user = await createUser();
  const migration = await createMigration(user.id, { status: 'COMPLETED', reviewCount: 1, completedAt: new Date() });
  const track = await prisma.migrationTrack.create({ data: {
    migrationId: migration.id, position: 1, spotifyTrackId: 'spotify-track', spotifyTitle: 'Song', spotifyArtists: ['Artist'], status: 'REVIEW',
  } });
  const candidate = await prisma.migrationCandidate.create({ data: {
    trackId: track.id, position: 0, videoId: 'video', title: 'Video', artists: ['Artist'], score: .95, reasons: [],
  } });
  return { user, migration, track, candidate };
}

integration('real transaction allows only one concurrent candidate selection', async () => {
  const fixture = await reviewFixture();
  const { app, headers } = await authenticatedApp(fixture.user.id);
  try {
    const request = () => app.inject({ method: 'POST', url: `/api/migrations/${fixture.migration.id}/reviews/${fixture.track.id}/choose`, headers, payload: { candidateId: fixture.candidate.id } });
    const responses = await Promise.all([request(), request()]);
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [202, 409]);
    const migration = await prisma.migration.findUnique({ where: { id: fixture.migration.id } });
    assert.equal(migration.reviewCount, 0);
    assert.equal(migration.confidentCount, 1);
  } finally { await app.close(); }
});

integration('real transaction resolves choose-versus-skip and skip-versus-skip races once', async () => {
  let fixture = await reviewFixture();
  let auth = await authenticatedApp(fixture.user.id);
  try {
    const responses = await Promise.all([
      auth.app.inject({ method: 'POST', url: `/api/migrations/${fixture.migration.id}/reviews/${fixture.track.id}/choose`, headers: auth.headers, payload: { candidateId: fixture.candidate.id } }),
      auth.app.inject({ method: 'POST', url: `/api/migrations/${fixture.migration.id}/reviews/${fixture.track.id}/skip`, headers: auth.headers }),
    ]);
    assert.equal(responses.filter((response) => response.statusCode < 300).length, 1);
    const row = await prisma.migration.findUnique({ where: { id: fixture.migration.id } });
    assert.equal(row.reviewCount, 0);
    assert.equal(row.confidentCount + row.skippedCount, 1);
  } finally { await auth.app.close(); }

  await cleanDatabase();
  fixture = await reviewFixture();
  auth = await authenticatedApp(fixture.user.id);
  try {
    const request = () => auth.app.inject({ method: 'POST', url: `/api/migrations/${fixture.migration.id}/reviews/${fixture.track.id}/skip`, headers: auth.headers });
    const responses = await Promise.all([request(), request()]);
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
    const row = await prisma.migration.findUnique({ where: { id: fixture.migration.id } });
    assert.equal(row.reviewCount, 0);
    assert.equal(row.skippedCount, 1);
  } finally { await auth.app.close(); }
});

integration('retry cannot race RUNNING state and is single-use from a terminal state', async () => {
  const user = await createUser();
  const migration = await createMigration(user.id, { failedCount: 1 });
  const failedTrack = await prisma.migrationTrack.create({ data: { migrationId: migration.id, position: 1, spotifyTrackId: 'spotify', spotifyTitle: 'Song', spotifyArtists: ['Artist'], matchedYoutubeVideoId: 'video', status: 'FAILED', needsReview: true } });
  const { app, headers } = await authenticatedApp(user.id);
  try {
    const active = await app.inject({ method: 'POST', url: `/api/migrations/${migration.id}/retry`, headers });
    assert.equal(active.statusCode, 409);
    await prisma.migration.update({ where: { id: migration.id }, data: { status: 'COMPLETED' } });
    const first = await app.inject({ method: 'POST', url: `/api/migrations/${migration.id}/retry`, headers });
    const second = await app.inject({ method: 'POST', url: `/api/migrations/${migration.id}/retry`, headers });
    assert.equal(first.statusCode, 202);
    assert.equal(second.statusCode, 409);
    assert.equal((await prisma.migrationTrack.findUnique({ where: { id: failedTrack.id } })).needsReview, true);
  } finally { await app.close(); }
});

integration('persisted phase controls resume independently of totals or partial tracks', async () => {
  const user = await createUser();
  const migration = await createMigration(user.id, { status: 'AUTHENTICATION_REQUIRED', phase: 'SCANNING', totalTracks: 100 });
  const { app, headers } = await authenticatedApp(user.id);
  try {
    const response = await app.inject({ method: 'POST', url: `/api/migrations/${migration.id}/resume`, headers });
    assert.equal(response.statusCode, 202);
    const row = await prisma.migration.findUnique({ where: { id: migration.id } });
    assert.equal(row.status, 'SCANNING');
    assert.equal(row.phase, 'SCANNING');
  } finally { await app.close(); }
});

integration('migration completes only when all required tracks are terminal', async () => {
  const user = await createUser();
  const migration = await createMigration(user.id);
  const track = await prisma.migrationTrack.create({ data: { migrationId: migration.id, position: 1, spotifyTrackId: 'spotify', spotifyTitle: 'Song', spotifyArtists: ['Artist'], matchedYoutubeVideoId: 'video', status: 'READY' } });
  const activeWorker = worker('worker-a');
  const job = await activeWorker.claim();
  assert.equal(await activeWorker.completeIfFinished(job), false);
  assert.equal((await prisma.migration.findUnique({ where: { id: migration.id } })).status, 'RUNNING');
  await prisma.migrationTrack.update({ where: { id: track.id }, data: { status: 'LIKED' } });
  assert.equal(await activeWorker.completeIfFinished(job), true);
  assert.equal((await prisma.migration.findUnique({ where: { id: migration.id } })).status, 'COMPLETED');
});

integration('migration track unique constraint rejects duplicate Spotify tracks', async () => {
  const user = await createUser();
  const migration = await createMigration(user.id);
  const data = { migrationId: migration.id, position: 1, spotifyTrackId: 'same-track', spotifyTitle: 'Song', spotifyArtists: ['Artist'] };
  await prisma.migrationTrack.create({ data });
  await assert.rejects(() => prisma.migrationTrack.create({ data: { ...data, position: 2 } }), (error) => error.code === 'P2002');
});

integration('PostgreSQL coordinates duplicate video likes across two migrations and workers', async () => {
  const user = await createUser();
  const deadline = new Date(Date.now() + 10_000);
  const attempts = await Promise.all([
    tryClaimVideoLike(prisma, { userId: user.id, videoId: 'same-video', ownerId: 'worker-a:migration-a', lockedUntil: deadline }),
    tryClaimVideoLike(prisma, { userId: user.id, videoId: 'same-video', ownerId: 'worker-b:migration-b', lockedUntil: deadline }),
  ]);
  assert.deepEqual(attempts.map((entry) => entry.state).sort(), ['BUSY', 'CLAIMED']);
  const winner = attempts.find((entry) => entry.state === 'CLAIMED');
  assert.equal((await completeVideoLike(prisma, winner.claim)).count, 1);
  assert.equal((await tryClaimVideoLike(prisma, { userId: user.id, videoId: 'same-video', ownerId: 'worker-b:migration-b', lockedUntil: deadline })).state, 'LIKED');
});
