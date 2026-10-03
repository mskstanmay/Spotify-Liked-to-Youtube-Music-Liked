const test = require('node:test');
const assert = require('node:assert/strict');
const { webConfig } = require('../src/api/config');
const { nativeWorkerConfig, validateNativeWorkerConfig } = require('../src/worker/nativeConfig');

const tokenEncryptionKey = Buffer.alloc(32, 9).toString('base64');

function environment(overrides = {}) {
  return {
    NODE_ENV: 'production',
    APP_ENV: 'production',
    DATABASE_URL: 'postgresql://worker:password@database.example.com:5432/musicmove',
    TOKEN_ENCRYPTION_KEY: tokenEncryptionKey,
    SPOTIFY_CLIENT_ID: 'spotify-client',
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    ...overrides,
  };
}

test('native worker configuration requires only worker/provider secrets', () => {
  const config = nativeWorkerConfig(environment());
  assert.equal(validateNativeWorkerConfig(config), true);
  assert.equal(config.spotify.clientId, 'spotify-client');
  assert.equal(config.spotify.clientSecret, undefined);
  assert.equal(config.sessionSecret, undefined);
  assert.equal(config.google.clientSecret, 'google-secret');
  assert.deepEqual(config.google.scopes, ['openid', 'profile', 'https://www.googleapis.com/auth/youtube.force-ssl']);
  assert.equal(config.ytmusicSearchLimit, 10);
  assert.equal(config.ytmusicSearchTimeoutMs, 30_000);
});

test('native worker configuration parses limits and preserves safe defaults', () => {
  const config = nativeWorkerConfig(environment({
    WORKER_POLL_MS: '2500',
    WORKER_LEASE_MS: '1000',
    YTMUSIC_SEARCH_LIMIT: '7',
    YTMUSIC_SEARCH_TIMEOUT_MS: '12000',
    AUTO_REVIEW_MIN_SCORE: '0.75',
  }));
  assert.equal(config.workerPollMs, 2500);
  assert.equal(config.workerLeaseMs, 60_000);
  assert.equal(config.ytmusicSearchLimit, 7);
  assert.equal(config.ytmusicSearchTimeoutMs, 12_000);
  assert.equal(config.autoReviewMinScore, 0.75);
});

test('migration track maximum is unlimited when missing or empty and accepts positive values', () => {
  const original = process.env.MIGRATION_MAX_TRACKS;
  try {
    delete process.env.MIGRATION_MAX_TRACKS;
    assert.equal(webConfig().migrationMaxTracks, null);
    assert.equal(nativeWorkerConfig(environment()).migrationMaxTracks, null);

    process.env.MIGRATION_MAX_TRACKS = '';
    assert.equal(webConfig().migrationMaxTracks, null);
    assert.equal(nativeWorkerConfig(environment({ MIGRATION_MAX_TRACKS: '' })).migrationMaxTracks, null);

    process.env.MIGRATION_MAX_TRACKS = '100';
    assert.equal(webConfig().migrationMaxTracks, 100);
    assert.equal(nativeWorkerConfig(environment({ MIGRATION_MAX_TRACKS: '100' })).migrationMaxTracks, 100);
  } finally {
    if (original === undefined) delete process.env.MIGRATION_MAX_TRACKS;
    else process.env.MIGRATION_MAX_TRACKS = original;
  }
});

test('native worker configuration rejects missing required values and malformed keys', () => {
  assert.throws(
    () => validateNativeWorkerConfig(nativeWorkerConfig(environment({ GOOGLE_CLIENT_SECRET: '' }))),
    /GOOGLE_CLIENT_SECRET/,
  );
  assert.throws(
    () => validateNativeWorkerConfig(nativeWorkerConfig(environment({ TOKEN_ENCRYPTION_KEY: 'invalid' }))),
    /base64-encoded 32-byte key/,
  );
});

test('native worker staging validation requires a specific database marker', () => {
  const valid = nativeWorkerConfig(environment({
    APP_ENV: 'staging',
    STAGING_DATABASE_IDENTIFIER: 'project-ref-123',
    DATABASE_URL: 'postgresql://postgres.project-ref-123:password@database.example.com:5432/postgres',
  }));
  assert.equal(validateNativeWorkerConfig(valid), true);

  const wrongDatabase = nativeWorkerConfig(environment({
    APP_ENV: 'staging',
    STAGING_DATABASE_IDENTIFIER: 'project-ref-123',
    DATABASE_URL: 'postgresql://postgres.other-project:password@database.example.com:5432/postgres',
  }));
  assert.throws(() => validateNativeWorkerConfig(wrongDatabase), /does not match/);
});
