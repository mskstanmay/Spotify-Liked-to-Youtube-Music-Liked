const path = require('node:path');
const { validateEncryptionKey } = require('../auth/security');
require('dotenv').config({ quiet: true });

const rootDir = path.resolve(__dirname, '..', '..');

function positiveInt(environment, name, fallback) {
  const value = Number(environment[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function optionalInt(environment, name) {
  const value = Number(environment[name]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function score(environment, name, fallback) {
  const raw = environment[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function nativeWorkerConfig(environment = process.env) {
  const nodeEnv = environment.NODE_ENV || 'development';
  const appEnv = environment.APP_ENV || (nodeEnv === 'production' ? 'production' : 'development');
  const workerLeaseMs = Math.max(60_000, positiveInt(environment, 'WORKER_LEASE_MS', 60_000));
  return {
    rootDir,
    nodeEnv,
    appEnv,
    databaseUrl: environment.DATABASE_URL || '',
    stagingDatabaseIdentifier: environment.STAGING_DATABASE_IDENTIFIER || '',
    tokenEncryptionKey: environment.TOKEN_ENCRYPTION_KEY || '',
    workerPollMs: positiveInt(environment, 'WORKER_POLL_MS', 1_500),
    workerLeaseMs,
    requestDelayMs: positiveInt(environment, 'REQUEST_DELAY_MS', 250),
    maxRetries: positiveInt(environment, 'MAX_RETRIES', 3),
    migrationMaxTracks: optionalInt(environment, 'MIGRATION_MAX_TRACKS'),
    autoReviewMinScore: score(environment, 'AUTO_REVIEW_MIN_SCORE', 0.72),
    ytmusicSearchLimit: positiveInt(environment, 'YTMUSIC_SEARCH_LIMIT', 10),
    ytmusicSearchTimeoutMs: positiveInt(environment, 'YTMUSIC_SEARCH_TIMEOUT_MS', 30_000),
    spotify: {
      clientId: environment.SPOTIFY_CLIENT_ID || '',
      scope: 'user-library-read user-read-private',
    },
    google: {
      clientId: environment.GOOGLE_CLIENT_ID || '',
      clientSecret: environment.GOOGLE_CLIENT_SECRET || '',
      scopes: ['openid', 'profile', 'https://www.googleapis.com/auth/youtube.force-ssl'],
      refreshLeaseMs: 35_000,
    },
  };
}

function validateNativeWorkerConfig(config) {
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.tokenEncryptionKey) missing.push('TOKEN_ENCRYPTION_KEY');
  if (!config.spotify.clientId) missing.push('SPOTIFY_CLIENT_ID');
  if (!config.google.clientId) missing.push('GOOGLE_CLIENT_ID');
  if (!config.google.clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  if (missing.length) throw new Error(`Missing required native worker configuration: ${missing.join(', ')}`);

  try {
    validateEncryptionKey(config.tokenEncryptionKey);
  } catch {
    throw new Error('Invalid native worker configuration: TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  }

  if (config.appEnv === 'staging') {
    if (config.nodeEnv !== 'production') throw new Error('Invalid staging configuration: NODE_ENV must be production.');
    const marker = String(config.stagingDatabaseIdentifier || '').toLowerCase();
    if (marker.length < 6 || ['postgres', 'supabase', 'staging', 'project'].includes(marker)) {
      throw new Error('Invalid staging configuration: STAGING_DATABASE_IDENTIFIER is required and must be specific.');
    }
    let databaseIdentity;
    try {
      const databaseUrl = new URL(config.databaseUrl);
      if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || !databaseUrl.hostname) throw new Error('invalid');
      databaseIdentity = `${databaseUrl.username}${databaseUrl.hostname}${databaseUrl.pathname}`.toLowerCase();
    } catch {
      throw new Error('Invalid staging configuration: DATABASE_URL must be a valid PostgreSQL URL.');
    }
    if (!databaseIdentity.includes(marker)) {
      throw new Error('Invalid staging configuration: DATABASE_URL does not match STAGING_DATABASE_IDENTIFIER.');
    }
  }
  return true;
}

module.exports = { nativeWorkerConfig, validateNativeWorkerConfig };
