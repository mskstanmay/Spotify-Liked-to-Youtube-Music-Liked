const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { encryptSecret, decryptSecret, csrfToken, hashToken } = require('../src/auth/security');
const { authorizationUrl: spotifyAuthorizationUrl } = require('../src/providers/spotify/web');
const { authorizationUrl: googleAuthorizationUrl, likeVideo, ratings } = require('../src/providers/youtube/web');
const { migrationJson, trackJson } = require('../src/migration/serialize');
const { counterData } = require('../src/migration/state');
const { trackWhere } = require('../src/migration/routes');
const { publicWorkerError, candidateRows, refreshCounts, MigrationWorker, isUsableAutoReviewMatch, scanResultData } = require('../src/worker/migrationWorker');
const { withRetries } = require('../src/utils/retry');
const { buildApp } = require('../src/api/app');

const encryptionKey = Buffer.alloc(32, 7).toString('base64');
const config = {
  nodeEnv: 'test',
  rootDir: process.cwd(),
  webBaseUrl: 'http://127.0.0.1:5173',
  apiBaseUrl: 'http://127.0.0.1:3000',
  sessionSecret: 'a'.repeat(48),
  sessionCookieName: 'musicmove_session',
  sessionDays: 30,
  tokenEncryptionKey: encryptionKey,
  spotify: { clientId: 'spotify-client', clientSecret: 'spotify-secret', redirectUri: 'http://127.0.0.1:3000/api/auth/spotify/callback', scope: 'user-library-read user-read-private' },
  google: { clientId: 'google-client', clientSecret: 'google-secret', redirectUri: 'http://127.0.0.1:3000/api/auth/google/callback', scopes: ['openid', 'profile', 'https://www.googleapis.com/auth/youtube.force-ssl'] },
};

function migration(overrides = {}) {
  return {
    id: 'mine', userId: 'user-a', source: 'spotify', destination: 'youtube_music', status: 'READY', phase: 'LIKING', leaseVersion: 0, workerId: null, lockedUntil: null, totalTracks: 10, processedTracks: 10,
    confidentCount: 7, likedCount: 0, alreadyLikedCount: 0, reviewCount: 3, notFoundCount: 0, failedCount: 0, skippedCount: 0,
    currentTrackTitle: null, currentTrackArtist: null, lastErrorCode: null, lastErrorMessage: null, startedAt: null, completedAt: null,
    createdAt: new Date('2026-09-20T00:00:00Z'), updatedAt: new Date('2026-09-20T00:00:00Z'), ...overrides,
  };
}

function fakePrisma() {
  const calls = { oauth: [], migrationCreates: [], trackUpdates: [], migrationUpdates: [] };
  let migrationRow = migration();
  let trackRow = { id: 'track-a', migrationId: 'mine', status: 'REVIEW', matchedYoutubeVideoId: null };
  const connection = {
    id: 'connection', userId: 'user-a', providerAccountId: 'provider-a', accountName: 'Listener', scopes: ['scope'], expiresAt: new Date(Date.now() + 60_000),
    encryptedAccessToken: 'encrypted-access-value', encryptedRefreshToken: 'encrypted-refresh-value',
  };
  const prisma = {
    calls,
    appSession: {
      findFirst: async ({ where }) => where.tokenHash === hashToken('browser-token') ? { id: 'session-a', userId: 'user-a', expiresAt: new Date(Date.now() + 60_000), user: { id: 'user-a', createdAt: new Date() } } : null,
      delete: async () => ({}),
    },
    oAuthState: { create: async ({ data }) => { calls.oauth.push(data); return data; }, findUnique: async () => null },
    user: { findUnique: async () => ({ id: 'user-a', spotifyConnection: connection, youtubeConnection: connection }), delete: async () => ({}) },
    spotifyConnection: { findUnique: async () => connection, deleteMany: async () => ({ count: 1 }) },
    youTubeConnection: { findUnique: async () => connection, deleteMany: async () => ({ count: 1 }) },
    migration: {
      findFirst: async ({ where }) => where.userId === 'user-a' && where.id === 'mine' ? { ...migrationRow } : null,
      findUnique: async () => ({ ...migrationRow }),
      findMany: async () => [{ ...migrationRow }],
      create: async ({ data }) => { calls.migrationCreates.push(data); return migration({ id: 'created', status: 'DRAFT' }); },
      update: async ({ data }) => { calls.migrationUpdates.push(data); migrationRow = { ...migrationRow, ...data }; return { ...migrationRow }; },
      updateMany: async ({ data }) => { migrationRow = { ...migrationRow, ...data, leaseVersion: data.leaseVersion?.increment ? migrationRow.leaseVersion + data.leaseVersion.increment : migrationRow.leaseVersion }; return { count: 1 }; },
    },
    migrationTrack: {
      findFirst: async ({ where }) => where.id === 'track-a' && where.migrationId === 'mine' ? { ...trackRow } : null,
      findMany: async () => [], count: async () => 0,
      update: async ({ data }) => { calls.trackUpdates.push(data); return data; },
      updateMany: async ({ where, data }) => {
        if (where.id && (where.id !== trackRow.id || (where.status && where.status !== trackRow.status))) return { count: 0 };
        calls.trackUpdates.push(data); trackRow = { ...trackRow, ...data }; return { count: 1 };
      },
      groupBy: async () => [{ status: trackRow.status, _count: { _all: 1 } }],
    },
    migrationCandidate: { findFirst: async ({ where }) => where.id === 'candidate-a' && where.trackId === 'track-a' ? { id: 'candidate-a', videoId: '-safe-id', title: 'Song', artists: ['Artist'], score: .9 } : null },
    $transaction: async (callback) => callback(prisma),
  };
  return prisma;
}

async function testApp() {
  const prisma = fakePrisma();
  const app = await buildApp({ prisma, config, logger: false });
  await app.ready();
  const cookie = `${config.sessionCookieName}=${app.signCookie('browser-token')}`;
  const csrf = csrfToken('session-a', config.sessionSecret);
  return { app, prisma, cookie, csrf };
}

test('provider tokens encrypt with authenticated encryption', () => {
  const encrypted = encryptSecret('top-secret-token', encryptionKey);
  assert.doesNotMatch(encrypted, /top-secret-token/);
  assert.equal(decryptSecret(encrypted, encryptionKey), 'top-secret-token');
  const parts = encrypted.split('.');
  parts[3] = `${parts[3][0] === 'A' ? 'B' : 'A'}${parts[3].slice(1)}`;
  assert.throws(() => decryptSecret(parts.join('.'), encryptionKey));
});

test('Spotify OAuth URL carries state, PKCE, library access, and the minimum profile scope', () => {
  const url = new URL(spotifyAuthorizationUrl(config, 'state-1', 'challenge-1'));
  assert.equal(url.searchParams.get('state'), 'state-1');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-1');
  assert.equal(url.searchParams.get('scope'), 'user-library-read user-read-private');
});

test('Google OAuth URL carries state, PKCE, offline access, and YouTube scope', () => {
  const url = new URL(googleAuthorizationUrl(config, 'state-2', 'challenge-2'));
  assert.equal(url.searchParams.get('state'), 'state-2');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-2');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.match(url.searchParams.get('scope'), /youtube\.force-ssl/);
});

test('OAuth starts persist only a state hash and encrypted verifier', async () => {
  const { app, prisma } = await testApp();
  const response = await app.inject({ method: 'GET', url: '/api/auth/spotify?returnTo=/connections' });
  assert.equal(response.statusCode, 302);
  const state = new URL(response.headers.location).searchParams.get('state');
  assert.equal(prisma.calls.oauth[0].stateHash, hashToken(state));
  assert.notEqual(prisma.calls.oauth[0].encryptedCodeVerifier, new URL(response.headers.location).searchParams.get('code_challenge'));
  await app.close();
});

test('Google OAuth state is persisted and invalid callbacks are rejected', async () => {
  const { app, prisma } = await testApp();
  const start = await app.inject({ method: 'GET', url: '/api/auth/google?returnTo=/settings' });
  assert.equal(start.statusCode, 302);
  assert.equal(prisma.calls.oauth[0].provider, 'GOOGLE');
  assert.equal(prisma.calls.oauth[0].returnTo, '/settings');
  const callback = await app.inject({ method: 'GET', url: '/api/auth/google/callback?state=forged&code=code' });
  assert.equal(callback.statusCode, 400);
  assert.equal(callback.json().error.code, 'INVALID_OAUTH_STATE');
  await app.close();
});

test('user A cannot access user B migration id', async () => {
  const { app, cookie } = await testApp();
  const mine = await app.inject({ method: 'GET', url: '/api/migrations/mine', headers: { cookie } });
  const theirs = await app.inject({ method: 'GET', url: '/api/migrations/theirs', headers: { cookie } });
  assert.equal(mine.statusCode, 200);
  assert.equal(theirs.statusCode, 404);
  await app.close();
});

test('migration creation requires CSRF and is owned by the session user', async () => {
  const { app, prisma, cookie, csrf } = await testApp();
  const blocked = await app.inject({ method: 'POST', url: '/api/migrations', headers: { cookie } });
  const created = await app.inject({ method: 'POST', url: '/api/migrations', headers: { cookie, 'x-csrf-token': csrf } });
  assert.equal(blocked.statusCode, 403);
  assert.equal(created.statusCode, 201);
  assert.deepEqual(prisma.calls.migrationCreates[0], { userId: 'user-a' });
  await app.close();
});

test('migration track limits are enforced server-side', async () => {
  const { app, prisma, cookie, csrf } = await testApp();
  const previousMaximum = config.migrationMaxTracks;
  config.migrationMaxTracks = 3;
  try {
    const blocked = await app.inject({ method: 'POST', url: '/api/migrations', headers: { cookie, 'x-csrf-token': csrf }, payload: { trackLimit: 4 } });
    const limited = await app.inject({ method: 'POST', url: '/api/migrations', headers: { cookie, 'x-csrf-token': csrf }, payload: { trackLimit: 1 } });
    const defaultLimited = await app.inject({ method: 'POST', url: '/api/migrations', headers: { cookie, 'x-csrf-token': csrf } });
    assert.equal(blocked.statusCode, 400);
    assert.equal(blocked.json().error.code, 'TRACK_LIMIT_EXCEEDED');
    assert.equal(limited.statusCode, 201);
    assert.equal(prisma.calls.migrationCreates[0].trackLimit, 1);
    assert.equal(defaultLimited.statusCode, 201);
    assert.equal(prisma.calls.migrationCreates[1].trackLimit, 3);
  } finally {
    config.migrationMaxTracks = previousMaximum;
    await app.close();
  }
});

test('provider token secrets never appear in connection API responses', async () => {
  const { app, cookie } = await testApp();
  const response = await app.inject({ method: 'GET', url: '/api/connections', headers: { cookie } });
  assert.equal(response.statusCode, 200);
  assert.doesNotMatch(response.body, /encrypted-access-value|encrypted-refresh-value|accessToken|refreshToken/);
  await app.close();
});

test('review candidate must belong to the owned review track', async () => {
  const { app, prisma, cookie, csrf } = await testApp();
  const response = await app.inject({ method: 'POST', url: '/api/migrations/mine/reviews/track-a/choose', headers: { cookie, 'x-csrf-token': csrf }, payload: { candidateId: 'candidate-a' } });
  assert.equal(response.statusCode, 202);
  assert.equal(prisma.calls.trackUpdates[0].matchedYoutubeVideoId, '-safe-id');
  assert.equal(prisma.calls.trackUpdates[0].status, 'READY');
  assert.equal(prisma.calls.trackUpdates[0].needsReview, false);
  await app.close();
});

test('migration progress serializer exposes safe counters and no internal lock', () => {
  const result = migrationJson(migration({ status: 'RUNNING', currentTrackTitle: 'Track', currentTrackArtist: 'Artist', workerId: 'secret-worker', likedCount: 3 }), { addedReviewCount: 1, needsReviewCount: 2 });
  assert.equal(result.status, 'running');
  assert.deepEqual(result.currentTrack, { title: 'Track', artist: 'Artist' });
  assert.equal(result.addedCount, 2);
  assert.equal(result.addedReviewCount, 1);
  assert.equal(result.needsReviewCount, 2);
  assert.equal(result.workerId, undefined);
});

test('SaaS scan classification auto-processes only safe medium matches', () => {
  const base = {
    matched: false, closeSecond: false, confidence: 'MEDIUM', score: 0.78,
    reason: 'Best score 0.78 is below threshold 0.85.', candidates: [{}],
    selectedCandidate: { videoId: 'video', title: 'Song', artists: ['Artist'], reasons: ['duration mismatch'] },
  };
  assert.equal(isUsableAutoReviewMatch(base, 0.72), true);
  assert.deepEqual(scanResultData(base, 0.72), {
    status: 'READY', needsReview: true, matchedYoutubeVideoId: 'video', matchedYoutubeTitle: 'Song',
    matchedYoutubeArtists: ['Artist'], confidence: 'MEDIUM', score: 0.78,
    reason: 'Best score 0.78 is below threshold 0.85.',
  });
  assert.equal(scanResultData({ ...base, score: 0.71 }, 0.72).status, 'REVIEW');
  assert.equal(scanResultData({ ...base, closeSecond: true }, 0.72).status, 'REVIEW');
  assert.equal(scanResultData({ ...base, selectedCandidate: { ...base.selectedCandidate, reasons: ['artist mismatch'] } }, 0.72).status, 'REVIEW');
  assert.equal(scanResultData({ ...base, selectedCandidate: { ...base.selectedCandidate, reasons: ['version mismatch'] } }, 0.72).status, 'REVIEW');
  assert.equal(scanResultData({ ...base, confidence: 'LOW' }, 0.72).status, 'REVIEW');
});

test('track serialization exposes review classification and matched result detail', () => {
  const result = trackJson({
    id: 'track', position: 1, spotifyTrackId: 'spotify', spotifyTitle: 'Source', spotifyArtists: ['Source Artist'],
    spotifyAlbum: 'Album', spotifyDurationMs: 1000, spotifyUrl: '', matchedYoutubeVideoId: 'video',
    matchedYoutubeTitle: 'Match', matchedYoutubeArtists: ['Match Artist'], confidence: 'MEDIUM', score: 0.78,
    reason: 'duration mismatch', needsReview: true, status: 'LIKED', errorMessage: null,
  });
  assert.equal(result.needsReview, true);
  assert.equal(result.resultCategory, 'added_review');
  assert.equal(result.match.title, 'Match');
  assert.equal(result.match.score, 0.78);
  assert.equal(result.match.reason, 'duration mismatch');
});

test('result filters map to safe status and review predicates', () => {
  assert.deepEqual(trackWhere('migration', { result: 'added_review' }), { migrationId: 'migration', status: 'LIKED', needsReview: true });
  assert.deepEqual(trackWhere('migration', { result: 'failed' }), { migrationId: 'migration', status: { in: ['FAILED', 'NOT_FOUND'] } });
  assert.deepEqual(trackWhere('migration', { needsReview: true }), { migrationId: 'migration', needsReview: true });
});

test('invalid result filters are rejected before reaching Prisma', async () => {
  const { app, cookie } = await testApp();
  const response = await app.inject({ method: 'GET', url: '/api/migrations/mine/tracks?result=not-a-result', headers: { cookie } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'INVALID_QUERY');
  await app.close();
});

test('worker error states distinguish authentication, quota, and temporary failure', () => {
  assert.equal(publicWorkerError({ authenticationRequired: true, provider: 'YouTube' }).status, 'AUTHENTICATION_REQUIRED');
  assert.equal(publicWorkerError({ quotaExceeded: true }).status, 'QUOTA_PAUSED');
  assert.equal(publicWorkerError({ retryable: true }).status, 'FAILED');
});

test('candidate rows retain conservative matcher review details', () => {
  const rows = candidateRows('track', [{ videoId: 'v', title: 'Song', artists: ['A'], score: .72, reasons: ['duration mismatch'] }]);
  assert.deepEqual(rows[0].reasons, ['duration mismatch']);
  assert.equal(rows[0].score, .72);
});

test('official YouTube like route safely handles a video id beginning with dash', async () => {
  const originalFetch = global.fetch;
  let requestUrl;
  global.fetch = async (url) => { requestUrl = String(url); return new Response(null, { status: 204 }); };
  try {
    const connection = { id: 'yt', expiresAt: new Date(Date.now() + 120_000), encryptedAccessToken: encryptSecret('access', encryptionKey) };
    await likeVideo({}, connection, config, '-abc123');
    assert.match(requestUrl, /videos\/rate\?id=-abc123&rating=like$/);
  } finally { global.fetch = originalFetch; }
});

test('already-liked detection uses official rating results', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ items: [{ videoId: 'liked-one', rating: 'like' }, { videoId: 'new-one', rating: 'none' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const connection = { id: 'yt', expiresAt: new Date(Date.now() + 120_000), encryptedAccessToken: encryptSecret('access', encryptionKey) };
    const result = await ratings({}, connection, config, ['liked-one', 'new-one']);
    assert.equal(result.get('liked-one'), 'like');
    assert.equal(result.get('new-one'), 'none');
  } finally { global.fetch = originalFetch; }
});

test('retry helper retries a transient failure and then succeeds', async () => {
  let attempts = 0;
  const result = await withRetries(async () => { attempts += 1; if (attempts < 2) throw new Error('temporary'); return 'ok'; }, { retries: 2, baseDelayMs: 1 });
  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
});

test('progress recomputation preserves matches and review queue counts', async () => {
  const updates = [];
  const prisma = {
    migrationTrack: { groupBy: async () => [{ status: 'LIKED', _count: { _all: 2 } }, { status: 'REVIEW', _count: { _all: 1 } }], count: async () => 2 },
    migration: { update: async ({ data }) => { updates.push(data); return { totalTracks: 3, ...data }; } },
  };
  await refreshCounts(prisma, 'migration', 'LIKING');
  assert.equal(updates[0].likedCount, 2);
  assert.equal(updates[0].reviewCount, 1);
  assert.equal(updates[0].processedTracks, 3);
  assert.equal(updates[0].confidentCount, 2);
  assert.equal(updates[0].addedReviewCount, undefined);
  assert.equal(updates[0].needsReviewCount, undefined);
});

test('counter recomputation derives review totals without persisting them', () => {
  const counters = counterData([
    { status: 'LIKED', needsReview: false, _count: { _all: 2 } },
    { status: 'LIKED', needsReview: true, _count: { _all: 1 } },
    { status: 'ALREADY_LIKED', needsReview: true, _count: { _all: 1 } },
    { status: 'REVIEW', needsReview: false, _count: { _all: 1 } },
  ], 4, 'LIKING');
  assert.equal(counters.likedCount, 3);
  assert.equal(counters.addedReviewCount, 1);
  assert.equal(counters.needsReviewCount, 2);
  assert.equal(counters.alreadyLikedCount, 1);
  assert.equal(counters.reviewCount, 1);
});

test('worker claim predicates include phase, status, lease expiry, and fencing version', async () => {
  let claimWhere;
  const prisma = {
    migration: {
      findFirst: async ({ where }) => {
        if (!claimWhere) { claimWhere = where; return migration({ status: 'RUNNING', phase: 'LIKING', leaseVersion: 4, lockedUntil: new Date(0) }); }
        return migration({ status: 'RUNNING', phase: 'LIKING', leaseVersion: 5, workerId: 'worker-test' });
      },
      updateMany: async ({ where }) => {
        assert.equal(where.status, 'RUNNING');
        assert.equal(where.phase, 'LIKING');
        assert.equal(where.leaseVersion, 4);
        return { count: 1 };
      },
    },
  };
  const worker = new MigrationWorker({ prisma, config: { workerLeaseMs: 1000 }, id: 'worker-test', logger: { error() {} } });
  const claimed = await worker.claim();
  assert.ok(claimWhere.OR.some((entry) => entry.status?.in?.includes('RUNNING')));
  assert.equal(claimed.status, 'RUNNING');
  assert.equal(claimed.leaseVersion, 5);
});
