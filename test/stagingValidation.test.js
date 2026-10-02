const test = require('node:test');
const assert = require('node:assert/strict');
const { validateConfig } = require('../src/api/config');
const { connectionJson } = require('../src/auth/routes');
const { migrationJson } = require('../src/migration/serialize');
const { operationEvent } = require('../src/utils/operationLogger');
const { expectedMigrations, runPreflight } = require('../src/staging/preflight');
const spotify = require('../src/providers/spotify/web');
const { encryptSecret } = require('../src/auth/security');
const { MigrationWorker } = require('../src/worker/migrationWorker');

const encryptionKey = Buffer.alloc(32, 5).toString('base64');

function stagingConfig(overrides = {}) {
  return {
    nodeEnv: 'production',
    appEnv: 'staging',
    secureDeployment: true,
    rootDir: process.cwd(),
    databaseUrl: 'postgresql://user:password@db.staging-project.supabase.co:5432/postgres',
    stagingDatabaseIdentifier: 'staging-project',
    apiBaseUrl: 'https://api.staging.example.com',
    webBaseUrl: 'https://staging.example.com',
    sessionSecret: 's'.repeat(48),
    tokenEncryptionKey: encryptionKey,
    workerReadyMaxAgeMs: 60_000,
    spotify: {
      clientId: 'spotify-client',
      clientSecret: 'spotify-secret',
      redirectUri: 'https://api.staging.example.com/api/auth/spotify/callback',
      scope: 'user-library-read user-read-private',
    },
    google: {
      clientId: 'google-client',
      clientSecret: 'google-secret',
      redirectUri: 'https://api.staging.example.com/api/auth/google/callback',
      scopes: ['openid', 'profile', 'https://www.googleapis.com/auth/youtube.force-ssl'],
    },
    ...overrides,
  };
}

test('staging startup requires production runtime semantics and the isolated database marker', () => {
  assert.doesNotThrow(() => validateConfig(stagingConfig()));
  assert.throws(() => validateConfig(stagingConfig({ nodeEnv: 'development' })), /NODE_ENV must be production/);
  assert.throws(() => validateConfig(stagingConfig({ stagingDatabaseIdentifier: '' })), /STAGING_DATABASE_IDENTIFIER is required/);
  assert.throws(
    () => validateConfig(stagingConfig({ databaseUrl: 'postgresql://user:password@db.production-project.supabase.co:5432/postgres' })),
    /does not match STAGING_DATABASE_IDENTIFIER/,
  );
});

test('connection status distinguishes usable, expired-refreshable, invalid, and reconnect-required states without secrets', () => {
  const common = {
    accountName: 'Listener', providerAccountId: 'provider-account', scopes: ['scope'],
    encryptedAccessToken: 'must-not-leak', encryptedRefreshToken: 'refresh-must-not-leak',
  };
  assert.equal(connectionJson(null).status, 'not_connected');
  assert.equal(connectionJson({ ...common, connectionStatus: 'ACTIVE', expiresAt: new Date(Date.now() + 60_000) }).status, 'connected');
  assert.equal(connectionJson({ ...common, connectionStatus: 'ACTIVE', expiresAt: new Date(0) }).status, 'expired_refreshable');
  assert.equal(connectionJson({ ...common, connectionStatus: 'AUTHENTICATION_INVALID', expiresAt: new Date(0) }).status, 'authentication_invalid');
  assert.equal(connectionJson({ ...common, encryptedRefreshToken: null, connectionStatus: 'ACTIVE', expiresAt: new Date(0) }).status, 'reconnect_required');
  assert.doesNotMatch(JSON.stringify(connectionJson({ ...common, expiresAt: new Date() })), /must-not-leak/);
});

test('a provider refresh rejection persists authentication-invalid connection health', async () => {
  const originalFetch = global.fetch;
  let healthUpdate;
  global.fetch = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
  const connection = {
    id: 'spotify', connectionStatus: 'ACTIVE', expiresAt: new Date(0),
    encryptedAccessToken: encryptSecret('old-access', encryptionKey),
    encryptedRefreshToken: encryptSecret('invalid-refresh', encryptionKey),
  };
  const prisma = { spotifyConnection: { updateMany: async ({ data }) => { healthUpdate = data; return { count: 1 }; } } };
  try {
    await assert.rejects(() => spotify.validAccessToken(prisma, connection, stagingConfig()), (error) => error.authenticationRequired === true);
    assert.equal(healthUpdate.connectionStatus, 'AUTHENTICATION_INVALID');
    assert.equal(connection.connectionStatus, 'AUTHENTICATION_INVALID');
  } finally {
    global.fetch = originalFetch;
  }
});

test('limited migration serialization makes its partial source scope explicit', () => {
  const serialized = migrationJson({
    id: 'migration', source: 'spotify', destination: 'youtube_music', status: 'COMPLETED', phase: 'LIKING',
    totalTracks: 3, sourceTotalTracks: 120, trackLimit: 3, processedTracks: 3,
    confidentCount: 3, likedCount: 3, alreadyLikedCount: 0, reviewCount: 0,
    notFoundCount: 0, failedCount: 0, skippedCount: 0,
  });
  assert.equal(serialized.limited, true);
  assert.equal(serialized.trackLimit, 3);
  assert.equal(serialized.sourceTotalTracks, 120);
});

test('server-side Spotify scan limit fetches only the selected scope and returns the full source total', async () => {
  const originalFetch = global.fetch;
  const requested = [];
  global.fetch = async (url) => {
    requested.push(String(url));
    return new Response(JSON.stringify({
      total: 120,
      items: [1, 2, 3].map((number) => ({ track: {
        id: `spotify-${number}`, name: `Song ${number}`, artists: [{ name: 'Artist' }],
        album: { name: 'Album' }, duration_ms: 1000, external_urls: { spotify: `https://open.spotify.com/${number}` },
      } })),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const connection = {
      id: 'spotify', connectionStatus: 'ACTIVE', expiresAt: new Date(Date.now() + 120_000),
      encryptedAccessToken: encryptSecret('access', encryptionKey), encryptedRefreshToken: encryptSecret('refresh', encryptionKey),
    };
    const result = await spotify.fetchLikedTracks({}, connection, { tokenEncryptionKey: encryptionKey, maxRetries: 0 }, undefined, undefined, 3);
    assert.equal(result.tracks.length, 3);
    assert.equal(result.sourceTotal, 120);
    assert.match(requested[0], /limit=3&offset=0/);
    assert.equal(requested.some((url) => url.includes('videos/rate')), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('preview scanning never invokes a mutating YouTube provider operation', async () => {
  let migration = {
    id: 'migration', userId: 'user', status: 'SCANNING', phase: 'SCANNING', workerId: 'worker-preview',
    leaseVersion: 1, lockedUntil: new Date(Date.now() + 60_000), startedAt: null, trackLimit: 1,
  };
  let tracks = [];
  const apply = (row, data) => {
    for (const [key, value] of Object.entries(data)) row[key] = value?.increment ? (row[key] || 0) + value.increment : value;
  };
  const prisma = {
    user: { findUnique: async () => ({ id: 'user', spotifyConnection: { id: 'spotify' } }) },
    migration: {
      findFirst: async () => ({ id: migration.id }),
      updateMany: async ({ data }) => { apply(migration, data); return { count: 1 }; },
      update: async ({ data }) => { apply(migration, data); return { ...migration }; },
    },
    migrationTrack: {
      count: async ({ where = {} }) => tracks.filter((track) => {
        if (where.matchedYoutubeVideoId?.not === null && !track.matchedYoutubeVideoId) return false;
        if (where.status?.in && !where.status.in.includes(track.status)) return false;
        return true;
      }).length,
      createMany: async ({ data }) => { tracks = data.map((track, index) => ({ id: `track-${index}`, status: 'PENDING', matchedYoutubeVideoId: null, matchedYoutubeArtists: [], ...track })); return { count: tracks.length }; },
      findFirst: async () => tracks.find((track) => ['PENDING', 'SCANNING'].includes(track.status)) || null,
      updateMany: async ({ where, data }) => {
        const selected = tracks.filter((track) => (!where.id || track.id === where.id) && (!where.status || where.status === track.status || where.status.in?.includes(track.status)));
        selected.forEach((track) => apply(track, data));
        return { count: selected.length };
      },
      groupBy: async () => Object.entries(tracks.reduce((groups, track) => ({ ...groups, [track.status]: (groups[track.status] || 0) + 1 }), {})).map(([status, count]) => ({ status, _count: { _all: count } })),
    },
    migrationCandidate: { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 1 }) },
  };
  prisma.$transaction = async (callback) => callback(prisma);
  let mutationCalls = 0;
  const worker = new MigrationWorker({
    prisma,
    id: 'worker-preview',
    logger: { info() {}, warn() {}, error() {} },
    config: { workerLeaseMs: 60_000, maxRetries: 0, requestDelayMs: 0 },
    providers: {
      fetchLikedTracks: async (database, connection, config, onProgress) => {
        await onProgress(1, 1, 100);
        return { sourceTotal: 100, tracks: [{ spotifyTrackId: 'spotify-1', title: 'Song', artists: ['Artist'], album: 'Album', durationMs: 1000, spotifyUrl: '' }] };
      },
      searchTrack: async () => [{ videoId: 'video-1', title: 'Song', artists: ['Artist'], album: 'Album', durationMs: 1000, resultType: 'song' }],
      youtube: { likeVideo: async () => { mutationCalls += 1; } },
    },
  });
  await worker.scan({ ...migration });
  assert.equal(mutationCalls, 0);
  assert.equal(migration.status, 'READY');
  assert.equal(migration.sourceTotalTracks, 100);
  assert.equal(tracks[0].status, 'READY');
});

test('structured provider operation logs use an allowlist and omit secrets and response bodies', () => {
  const event = operationEvent({
    migrationId: 'migration', trackId: 'track', provider: 'youtube', operation: 'videos.rate',
    retryNumber: 1, durationMs: 25, result: 'liked', accessToken: 'secret',
    authorization: 'Bearer secret', clientSecret: 'secret', responseBody: 'secret',
  }, new Date('2026-09-21T00:00:00.000Z'));
  assert.deepEqual(event, {
    event: 'provider_operation', timestamp: '2026-09-21T00:00:00.000Z', migrationId: 'migration',
    trackId: 'track', provider: 'youtube', operation: 'videos.rate', retryNumber: 1,
    durationMs: 25, result: 'liked',
  });
  assert.doesNotMatch(JSON.stringify(event), /secret|Bearer/);
});

test('staging preflight verifies migration state, worker heartbeat, and health endpoints without exposing secrets', async () => {
  const expected = expectedMigrations(process.cwd());
  const prisma = {
    $queryRawUnsafe: async (query) => query === 'SELECT 1' ? [{ '?column?': 1 }] : expected.map((migration_name) => ({ migration_name })),
    workerRuntime: { findFirst: async () => ({ id: 'worker-a' }) },
  };
  const fetchImpl = async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  const result = await runPreflight({ config: stagingConfig(), prisma, fetchImpl });
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map((check) => check.name), ['configuration', 'database', 'migrations', 'worker', 'api_health', 'api_ready']);
  assert.doesNotMatch(JSON.stringify(result), /password|spotify-secret|google-secret/);
});
