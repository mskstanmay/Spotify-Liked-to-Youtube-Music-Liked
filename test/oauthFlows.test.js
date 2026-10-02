const test = require('node:test');
const assert = require('node:assert/strict');
const { buildApp } = require('../src/api/app');
const spotify = require('../src/providers/spotify/web');
const youtube = require('../src/providers/youtube/web');
const { connectAccount } = require('../src/auth/routes');
const { encryptSecret, decryptSecret } = require('../src/auth/security');

const encryptionKey = Buffer.alloc(32, 9).toString('base64');
const config = {
  nodeEnv: 'test',
  rootDir: process.cwd(),
  webBaseUrl: 'http://127.0.0.1:5173',
  apiBaseUrl: 'http://127.0.0.1:3000',
  sessionSecret: 's'.repeat(48),
  sessionCookieName: 'musicmove_session',
  sessionDays: 30,
  tokenEncryptionKey: encryptionKey,
  spotify: { clientId: 'spotify-client', redirectUri: 'http://127.0.0.1:3000/api/auth/spotify/callback', scope: 'user-library-read user-read-private' },
  google: { clientId: 'google-client', clientSecret: 'google-secret', redirectUri: 'http://127.0.0.1:3000/api/auth/google/callback', scopes: ['openid', 'profile', 'https://www.googleapis.com/auth/youtube.force-ssl'] },
};

function connectionPrisma(provider, existing = null) {
  let connection = existing ? { ...existing } : null;
  let createdUsers = 0;
  const modelName = provider === 'spotify' ? 'spotifyConnection' : 'youTubeConnection';
  const model = {
    findUnique: async ({ where }) => {
      if (where.userId) return connection?.userId === where.userId ? { ...connection } : null;
      if (where.providerAccountId) return connection?.providerAccountId === where.providerAccountId ? { ...connection } : null;
      return null;
    },
    upsert: async ({ create, update }) => {
      if (connection) {
        const refreshVersion = update.refreshVersion?.increment
          ? (connection.refreshVersion || 0) + update.refreshVersion.increment
          : update.refreshVersion;
        connection = { ...connection, ...update, ...(refreshVersion === undefined ? {} : { refreshVersion }) };
      } else {
        connection = { id: 'connection', ...create };
      }
      return { ...connection };
    },
  };
  const prisma = {
    [modelName]: model,
    user: { create: async () => ({ id: `new-user-${++createdUsers}` }) },
  };
  prisma.$transaction = async (callback) => callback(prisma);
  return { prisma, get connection() { return connection; } };
}

test('Spotify PKCE exchange sends the documented form fields without Basic authentication', async () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: config.spotify.scope }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const token = await spotify.exchangeCode(config, 'authorization-code', 'valid-verifier');
    const form = new URLSearchParams(captured.options.body);
    assert.equal(token.access_token, 'access');
    assert.equal(form.get('client_id'), 'spotify-client');
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('code'), 'authorization-code');
    assert.equal(form.get('redirect_uri'), config.spotify.redirectUri);
    assert.equal(form.get('code_verifier'), 'valid-verifier');
    assert.equal(captured.options.headers.Authorization, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Spotify token exchange rejects an invalid PKCE verifier without changing an account', async () => {
  const originalFetch = global.fetch;
  const store = connectionPrisma('spotify', { id: 'connection', userId: 'user', providerAccountId: 'account-a' });
  global.fetch = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(() => spotify.exchangeCode(config, 'code', 'wrong-verifier'), (error) => error.code === 'invalid_grant');
    assert.equal(store.connection.providerAccountId, 'account-a');
  } finally {
    global.fetch = originalFetch;
  }
});

test('Spotify profile uses the immutable account_id for account linkage', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ account_id: 'immutable-account', id: 'changeable-user-id', display_name: 'Listener' }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    assert.deepEqual(await spotify.profile('access'), { id: 'immutable-account', name: 'Listener' });
  } finally {
    global.fetch = originalFetch;
  }
});

for (const [name, implementation, connection] of [
  ['Spotify', spotify, 'spotifyConnection'],
  ['Google', youtube, 'youTubeConnection'],
]) {
  const definition = { connection, implementation };

  test(`${name} same-account reconnect preserves an omitted refresh token`, async () => {
    const oldRefresh = encryptSecret('old-refresh', encryptionKey);
    const store = connectionPrisma(name === 'Spotify' ? 'spotify' : 'google', { id: 'connection', userId: 'user', providerAccountId: 'account-a', encryptedRefreshToken: oldRefresh });
    await connectAccount(store.prisma, definition, { userId: 'user' }, { id: 'account-a', name: 'Same' }, { access_token: 'new-access', expires_in: 3600 }, config);
    assert.equal(decryptSecret(store.connection.encryptedRefreshToken, encryptionKey), 'old-refresh');
  });

  test(`${name} different-account reconnect never reuses an omitted refresh token`, async () => {
    const oldRefresh = encryptSecret('old-refresh', encryptionKey);
    const store = connectionPrisma(name === 'Spotify' ? 'spotify' : 'google', { id: 'connection', userId: 'user', providerAccountId: 'account-a', encryptedRefreshToken: oldRefresh });
    await assert.rejects(
      () => connectAccount(store.prisma, definition, { userId: 'user' }, { id: 'account-b', name: 'Different' }, { access_token: 'new-access', expires_in: 3600 }, config),
      (error) => error.code === 'REFRESH_TOKEN_REQUIRED',
    );
    assert.equal(store.connection.providerAccountId, 'account-a');
    assert.equal(decryptSecret(store.connection.encryptedRefreshToken, encryptionKey), 'old-refresh');
  });

  test(`${name} different-account reconnect accepts a new refresh token`, async () => {
    const store = connectionPrisma(name === 'Spotify' ? 'spotify' : 'google', { id: 'connection', userId: 'user', providerAccountId: 'account-a', encryptedRefreshToken: encryptSecret('old-refresh', encryptionKey) });
    await connectAccount(store.prisma, definition, { userId: 'user' }, { id: 'account-b', name: 'Different' }, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }, config);
    assert.equal(store.connection.providerAccountId, 'account-b');
    assert.equal(decryptSecret(store.connection.encryptedRefreshToken, encryptionKey), 'new-refresh');
    if (name === 'Google') assert.equal(store.connection.refreshVersion, 1);
  });
}

test('successful Spotify callback consumes state, uses PKCE, links account_id, and creates a session', async () => {
  const originalFetch = global.fetch;
  let stateRow;
  let linked;
  let sessionCreated = false;
  const prisma = {
    oAuthState: {
      create: async ({ data }) => { stateRow = { id: 'state-row', ...data }; return stateRow; },
      findUnique: async ({ where }) => stateRow?.stateHash === where.stateHash ? stateRow : null,
      delete: async () => { stateRow = null; },
    },
    appSession: {
      findFirst: async () => null,
      create: async ({ data }) => { sessionCreated = true; return { id: 'session', ...data }; },
    },
    user: { create: async () => ({ id: 'new-user' }) },
    spotifyConnection: {
      findUnique: async () => linked,
      upsert: async ({ create, update }) => { linked = linked ? { ...linked, ...update } : { id: 'spotify', ...create }; return linked; },
    },
  };
  prisma.$transaction = async (callback) => callback(prisma);
  let tokenForm;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes('/api/token')) {
      tokenForm = new URLSearchParams(options.body);
      return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: config.spotify.scope }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ account_id: 'stable-account', id: 'legacy-id', display_name: 'Listener' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = await buildApp({ prisma, config, logger: false });
  try {
    const start = await app.inject({ method: 'GET', url: '/api/auth/spotify' });
    const state = new URL(start.headers.location).searchParams.get('state');
    const callback = await app.inject({ method: 'GET', url: `/api/auth/spotify/callback?state=${encodeURIComponent(state)}&code=valid-code` });
    assert.equal(callback.statusCode, 302);
    assert.equal(linked.providerAccountId, 'stable-account');
    assert.ok(tokenForm.get('code_verifier'));
    assert.equal(stateRow, null);
    assert.equal(sessionCreated, true);
  } finally {
    await app.close();
    global.fetch = originalFetch;
  }
});
