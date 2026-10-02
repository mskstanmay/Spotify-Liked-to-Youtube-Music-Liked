const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { jsonResponse, retryAfterMs } = require('../src/providers/http');
const youtube = require('../src/providers/youtube/web');
const { encryptSecret } = require('../src/auth/security');
const { runPython } = require('../src/ytmusic/client');
const { tryClaimVideoLike, completeVideoLike } = require('../src/worker/videoLikeCoordinator');
const { migrationEventId, shouldSendMigration, migrationEvent } = require('../src/migration/sse');
const { buildApp } = require('../src/api/app');
const { validateConfig } = require('../src/api/config');
const { withRetries } = require('../src/utils/retry');

const encryptionKey = Buffer.alloc(32, 7).toString('base64');

function baseConfig(overrides = {}) {
  return {
    nodeEnv: 'test',
    rootDir: process.cwd(),
    webBaseUrl: 'http://127.0.0.1:5173',
    apiBaseUrl: 'http://127.0.0.1:3000',
    sessionSecret: 's'.repeat(48),
    sessionCookieName: 'musicmove_session',
    sessionDays: 30,
    tokenEncryptionKey: encryptionKey,
    maxRetries: 0,
    requireWorkerReady: false,
    workerReadyMaxAgeMs: 15_000,
    spotify: {
      clientId: 'spotify-client',
      clientSecret: 'spotify-secret',
      redirectUri: 'http://127.0.0.1:3000/api/auth/spotify/callback',
      scope: 'user-library-read user-read-private',
    },
    google: {
      clientId: 'google-client',
      clientSecret: 'google-secret',
      redirectUri: 'http://127.0.0.1:3000/api/auth/google/callback',
      scopes: ['openid', 'profile', 'https://www.googleapis.com/auth/youtube.force-ssl'],
      refreshLeaseMs: 500,
    },
    databaseUrl: 'postgresql://example.invalid/test',
    ...overrides,
  };
}

function googleError(status, reason) {
  return new Response(JSON.stringify({ error: { errors: [{ reason }], status: reason } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Google rate limits are retryable while daily quota exhaustion pauses', async () => {
  await assert.rejects(
    () => jsonResponse(googleError(403, 'rateLimitExceeded'), 'YouTube'),
    (error) => error.retryable === true && error.quotaExceeded === false && error.code === 'rateLimitExceeded',
  );
  await assert.rejects(
    () => jsonResponse(googleError(429, 'RESOURCE_EXHAUSTED'), 'YouTube'),
    (error) => error.retryable === true && error.quotaExceeded === false,
  );
  await assert.rejects(
    () => jsonResponse(googleError(403, 'quotaExceeded'), 'YouTube'),
    (error) => error.retryable === false && error.quotaExceeded === true && error.code === 'quotaExceeded',
  );
});

test('Spotify Retry-After accepts seconds, handles missing values, and caps unreasonable delays', async () => {
  assert.equal(retryAfterMs(new Response(null, { status: 429, headers: { 'retry-after': '7' } })), 7000);
  assert.equal(retryAfterMs(new Response(null, { status: 429 })), null);
  assert.equal(retryAfterMs(new Response(null, { status: 429, headers: { 'retry-after': '999999999' } })), 60_000);
  assert.equal(retryAfterMs(new Response(null, { status: 429, headers: { 'retry-after': 'not-a-number' } })), null);
  const delays = [];
  let attempts = 0;
  await withRetries(async () => {
    attempts += 1;
    if (attempts === 1) {
      await jsonResponse(new Response(JSON.stringify({ error: { status: 429 } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '7' },
      }), 'Spotify');
    }
    return 'ok';
  }, { retries: 1, sleepFn: async (delay) => delays.push(delay) });
  assert.deepEqual(delays, [7000]);
});

function refreshPrisma(initial) {
  let row = { ...initial };
  const matches = (where) => {
    if (where.id !== undefined && where.id !== row.id) return false;
    if (where.refreshVersion !== undefined && where.refreshVersion !== row.refreshVersion) return false;
    if (where.refreshOwner !== undefined && where.refreshOwner !== row.refreshOwner) return false;
    if (where.OR) {
      const now = where.OR.find((entry) => entry.refreshLockedUntil?.lt)?.refreshLockedUntil?.lt;
      if (!(row.refreshLockedUntil === null || (now && row.refreshLockedUntil < now))) return false;
    }
    return true;
  };
  const model = {
    findUnique: async () => ({ ...row }),
    updateMany: async ({ where, data }) => {
      if (!matches(where)) return { count: 0 };
      row = {
        ...row,
        ...data,
        refreshVersion: data.refreshVersion?.increment
          ? row.refreshVersion + data.refreshVersion.increment
          : (data.refreshVersion ?? row.refreshVersion),
      };
      return { count: 1 };
    },
  };
  return { prisma: { youTubeConnection: model }, current: () => ({ ...row }) };
}

function expiredConnection() {
  return {
    id: 'youtube-connection',
    userId: 'user-a',
    refreshVersion: 0,
    refreshOwner: null,
    refreshLockedUntil: null,
    expiresAt: new Date(0),
    encryptedAccessToken: encryptSecret('old-access', encryptionKey),
    encryptedRefreshToken: encryptSecret('refresh-token', encryptionKey),
  };
}

test('a Google 401 refreshes server-side and retries the original request exactly once', async () => {
  const originalFetch = global.fetch;
  const store = refreshPrisma(expiredConnection());
  const connection = { ...store.current(), expiresAt: new Date(Date.now() + 120_000) };
  let tokenCalls = 0;
  let apiCalls = 0;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      tokenCalls += 1;
      return new Response(JSON.stringify({ access_token: 'new-access', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    apiCalls += 1;
    if (options.headers.Authorization === 'Bearer old-access') return googleError(401, 'authError');
    assert.equal(options.headers.Authorization, 'Bearer new-access');
    return new Response(null, { status: 204 });
  };
  try {
    await youtube.likeVideo(store.prisma, connection, baseConfig(), 'video-a');
    assert.equal(tokenCalls, 1);
    assert.equal(apiCalls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('concurrent Google refresh callers share one database-coordinated refresh', async () => {
  const originalFetch = global.fetch;
  const store = refreshPrisma(expiredConnection());
  let tokenCalls = 0;
  global.fetch = async () => {
    tokenCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ access_token: 'shared-access', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const [first, second] = await Promise.all([
      youtube.validAccessToken(store.prisma, { ...store.current() }, baseConfig()),
      youtube.validAccessToken(store.prisma, { ...store.current() }, baseConfig()),
    ]);
    assert.deepEqual([first, second], ['shared-access', 'shared-access']);
    assert.equal(tokenCalls, 1);
    assert.equal(store.current().refreshVersion, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Python subprocess timeout kills the child and returns a retryable structured error without public-search secrets', async () => {
  const originalId = process.env.YTMUSIC_CLIENT_ID;
  const originalSecret = process.env.YTMUSIC_CLIENT_SECRET;
  const originalTokenKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.YTMUSIC_CLIENT_ID = 'do-not-pass-id';
  process.env.YTMUSIC_CLIENT_SECRET = 'do-not-pass-secret';
  process.env.TOKEN_ENCRYPTION_KEY = 'do-not-pass-server-key';
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let killedWith;
  child.kill = (signal) => { killedWith = signal; return true; };
  let invocation;
  try {
    await assert.rejects(
      () => runPython(['search', '--query', 'song', '--limit', '1'], {
        timeoutMs: 10,
        ensurePythonReadyImpl: async () => 'python-test',
        spawnImpl: (command, args, options) => { invocation = { command, args, options }; return child; },
      }),
      (error) => error.code === 'PYTHON_TIMEOUT' && error.retryable === true,
    );
    assert.equal(killedWith, 'SIGKILL');
    assert.equal(invocation.command, 'python-test');
    assert.equal(invocation.args.includes('do-not-pass-secret'), false);
    assert.equal(invocation.options.env.YTMUSIC_CLIENT_ID, undefined);
    assert.equal(invocation.options.env.YTMUSIC_CLIENT_SECRET, undefined);
    assert.equal(invocation.options.env.TOKEN_ENCRYPTION_KEY, undefined);
  } finally {
    if (originalId === undefined) delete process.env.YTMUSIC_CLIENT_ID; else process.env.YTMUSIC_CLIENT_ID = originalId;
    if (originalSecret === undefined) delete process.env.YTMUSIC_CLIENT_SECRET; else process.env.YTMUSIC_CLIENT_SECRET = originalSecret;
    if (originalTokenKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = originalTokenKey;
  }
});

function videoLikePrisma() {
  let row;
  const model = {
    upsert: async ({ create }) => {
      if (!row) row = { id: 'like-row', status: 'PENDING', ownerId: null, lockedUntil: null, leaseVersion: 0, ...create };
      return { ...row };
    },
    updateMany: async ({ where, data }) => {
      const lockAvailable = !where.OR || row.lockedUntil === null || row.lockedUntil < where.OR[1].lockedUntil.lt;
      const matches = row.id === where.id
        && (!where.status || row.status === where.status)
        && (where.ownerId === undefined || row.ownerId === where.ownerId)
        && (where.leaseVersion === undefined || row.leaseVersion === where.leaseVersion)
        && lockAvailable;
      if (!matches) return { count: 0 };
      row = {
        ...row,
        ...data,
        leaseVersion: data.leaseVersion?.increment ? row.leaseVersion + data.leaseVersion.increment : row.leaseVersion,
      };
      return { count: 1 };
    },
    findUnique: async () => ({ ...row }),
  };
  return { youTubeVideoLike: model };
}

test('two workers coordinate one per-user video like through the database row', async () => {
  const prisma = videoLikePrisma();
  const common = { userId: 'same-user', videoId: 'same-video', lockedUntil: new Date(Date.now() + 1000) };
  const attempts = await Promise.all([
    tryClaimVideoLike(prisma, { ...common, ownerId: 'worker-a:migration-a' }),
    tryClaimVideoLike(prisma, { ...common, ownerId: 'worker-b:migration-b' }),
  ]);
  assert.deepEqual(attempts.map((entry) => entry.state).sort(), ['BUSY', 'CLAIMED']);
  const winner = attempts.find((entry) => entry.state === 'CLAIMED');
  assert.equal((await completeVideoLike(prisma, winner.claim)).count, 1);
  assert.equal((await tryClaimVideoLike(prisma, { ...common, ownerId: 'worker-b:migration-b' })).state, 'LIKED');
});

test('SSE reconnect IDs suppress the last delivered snapshot and recover current state', () => {
  const previous = { id: 'migration-a', status: 'running', updatedAt: '2026-09-21T10:00:00.000Z' };
  const current = { ...previous, status: 'completed', updatedAt: '2026-09-21T10:00:01.000Z' };
  assert.equal(shouldSendMigration(migrationEventId(previous), previous), false);
  assert.equal(shouldSendMigration(migrationEventId(previous), current), true);
  const event = migrationEvent(current);
  assert.match(event, /^id: 2026-09-21T10:00:01\.000Z\nevent: migration\n/);
  assert.match(event, /"status":"completed"/);
});

test('readiness reports database and worker failures without exposing configuration', async () => {
  const databaseFailure = await buildApp({
    prisma: { $queryRawUnsafe: async () => { throw new Error('database password should stay private'); } },
    config: baseConfig(),
    logger: false,
  });
  const failed = await databaseFailure.inject({ method: 'GET', url: '/api/ready' });
  assert.equal(failed.statusCode, 503);
  assert.deepEqual(failed.json(), { ok: false, checks: { configuration: true, database: false, worker: true } });
  assert.doesNotMatch(failed.body, /password/);
  await databaseFailure.close();

  const staleWorker = await buildApp({
    prisma: { $queryRawUnsafe: async () => 1, workerRuntime: { findFirst: async () => null } },
    config: baseConfig({ requireWorkerReady: true }),
    logger: false,
  });
  const stale = await staleWorker.inject({ method: 'GET', url: '/api/ready' });
  assert.equal(stale.statusCode, 503);
  assert.deepEqual(stale.json().checks, { configuration: true, database: true, worker: false });
  await staleWorker.close();
});

test('startup validation rejects malformed encryption keys', () => {
  assert.throws(
    () => validateConfig(baseConfig({ tokenEncryptionKey: `${encryptionKey}!` })),
    /base64-encoded 32-byte key/,
  );
});

test('production startup rejects loopback and non-HTTPS redirect configuration', () => {
  const config = baseConfig({
    nodeEnv: 'production',
    apiBaseUrl: 'https://api.example.com',
    webBaseUrl: 'https://app.example.com',
    spotify: { clientId: 'spotify', clientSecret: 'secret', redirectUri: 'http://127.0.0.1:3000/api/auth/spotify/callback', scope: 'user-library-read user-read-private' },
    google: { clientId: 'google', clientSecret: 'secret', redirectUri: 'https://api.example.com/api/auth/google/callback', scopes: ['openid'] },
  });
  assert.throws(() => validateConfig(config), /SPOTIFY_WEB_REDIRECT_URI must use non-loopback HTTPS/);
  config.spotify.redirectUri = 'https://api.example.com/api/auth/spotify/callback';
  config.google.redirectUri = 'https://[::1]/api/auth/google/callback';
  assert.throws(() => validateConfig(config), /GOOGLE_REDIRECT_URI must use non-loopback HTTPS/);
});
