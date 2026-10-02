const path = require('node:path');
const { validateEncryptionKey } = require('../auth/security');
require('dotenv').config({ quiet: true });

const rootDir = path.resolve(__dirname, '..', '..');

function int(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function optionalInt(name) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function webConfig(overrides = {}) {
  const port = int('PORT', 3000);
  const apiBaseUrl = process.env.API_BASE_URL || `http://127.0.0.1:${port}`;
  const nodeEnv = process.env.NODE_ENV || 'development';
  const appEnv = process.env.APP_ENV || (nodeEnv === 'production' ? 'production' : 'development');
  const workerLeaseMs = Math.max(60_000, int('WORKER_LEASE_MS', 60_000));
  const config = {
    rootDir,
    port,
    host: process.env.HOST || '127.0.0.1',
    apiBaseUrl,
    webBaseUrl: process.env.WEB_BASE_URL || 'http://127.0.0.1:5173',
    nodeEnv,
    appEnv,
    secureDeployment: !['development', 'test'].includes(nodeEnv) || ['staging', 'production'].includes(appEnv),
    databaseUrl: process.env.DATABASE_URL || '',
    stagingDatabaseIdentifier: process.env.STAGING_DATABASE_IDENTIFIER || '',
    sessionCookieName: 'musicmove_session',
    sessionSecret: process.env.SESSION_SECRET || '',
    tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY || '',
    sessionDays: int('SESSION_DAYS', 30),
    workerPollMs: int('WORKER_POLL_MS', 1500),
    // Provider requests time out at 30 seconds. A 60-second minimum leaves a
    // drain window after pause/fence invalidation before another worker claims.
    workerLeaseMs,
    requestDelayMs: int('REQUEST_DELAY_MS', 250),
    maxRetries: int('MAX_RETRIES', 3),
    pythonTimeoutMs: int('PYTHON_SUBPROCESS_TIMEOUT_MS', 30_000),
    migrationMaxTracks: optionalInt('MIGRATION_MAX_TRACKS'),
    requireWorkerReady: nodeEnv === 'production',
    workerReadyMaxAgeMs: int('WORKER_READY_MAX_AGE_MS', Math.max(30_000, workerLeaseMs)),
    spotify: {
      clientId: process.env.SPOTIFY_CLIENT_ID || '',
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
      redirectUri: process.env.SPOTIFY_WEB_REDIRECT_URI || `${apiBaseUrl}/api/auth/spotify/callback`,
      scope: 'user-library-read user-read-private',
    },
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      redirectUri: process.env.GOOGLE_REDIRECT_URI || `${apiBaseUrl}/api/auth/google/callback`,
      scopes: ['openid', 'profile', 'https://www.googleapis.com/auth/youtube.force-ssl'],
      refreshLeaseMs: 35_000,
    },
    ...overrides,
  };
  if (!Object.hasOwn(overrides, 'secureDeployment')) config.secureDeployment = !['development', 'test'].includes(config.nodeEnv) || ['staging', 'production'].includes(config.appEnv);
  if (!Object.hasOwn(overrides, 'requireWorkerReady')) config.requireWorkerReady = config.secureDeployment;
  return config;
}

function productionUrlError(label, value) {
  let url;
  try { url = new URL(value); } catch { return `${label} must be a valid URL`; }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || /^127(?:\.|$)/.test(hostname)
    || hostname === '::1'
    || hostname === '0:0:0:0:0:0:0:1';
  if (url.protocol !== 'https:' || loopback) return `${label} must use non-loopback HTTPS in production`;
  return null;
}

function validateConfig(config, { worker = false } = {}) {
  const secureDeployment = config.secureDeployment
    ?? (!['development', 'test'].includes(config.nodeEnv) || ['staging', 'production'].includes(config.appEnv));
  const missing = [];
  if (!config.databaseUrl && !process.env.DATABASE_URL) missing.push('DATABASE_URL');
  if (!config.sessionSecret || config.sessionSecret.length < 32) missing.push('SESSION_SECRET (at least 32 characters)');
  if (!config.tokenEncryptionKey) missing.push('TOKEN_ENCRYPTION_KEY');
  if (!config.spotify.clientId || !config.spotify.clientSecret) missing.push('SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET');
  if (!config.google.clientId || !config.google.clientSecret) missing.push('GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET');
  if (missing.length) throw new Error(`Missing required web configuration: ${missing.join(', ')}`);
  try {
    validateEncryptionKey(config.tokenEncryptionKey);
  } catch {
    throw new Error('Invalid web configuration: TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  }
  if (config.appEnv === 'staging') {
    if (config.nodeEnv !== 'production') throw new Error('Invalid staging configuration: NODE_ENV must be production.');
    const marker = String(config.stagingDatabaseIdentifier || '').toLowerCase();
    if (marker.length < 6 || ['postgres', 'supabase', 'staging', 'project'].includes(marker)) throw new Error('Invalid staging configuration: STAGING_DATABASE_IDENTIFIER is required and must be specific.');
    let databaseIdentity = '';
    try {
      const databaseUrl = new URL(config.databaseUrl || process.env.DATABASE_URL);
      databaseIdentity = `${databaseUrl.username}${databaseUrl.hostname}${databaseUrl.pathname}`.toLowerCase();
    } catch {
      throw new Error('Invalid staging configuration: DATABASE_URL must be a valid PostgreSQL URL.');
    }
    if (!databaseIdentity.includes(marker)) {
      throw new Error('Invalid staging configuration: DATABASE_URL does not match STAGING_DATABASE_IDENTIFIER.');
    }
  }
  if (secureDeployment) {
    const unsafe = [
      productionUrlError('API_BASE_URL', config.apiBaseUrl),
      productionUrlError('WEB_BASE_URL', config.webBaseUrl),
      productionUrlError('SPOTIFY_WEB_REDIRECT_URI', config.spotify.redirectUri),
      productionUrlError('GOOGLE_REDIRECT_URI', config.google.redirectUri),
    ].filter(Boolean);
    if (unsafe.length) throw new Error(`Invalid production web configuration: ${unsafe.join(', ')}`);
  }
}

module.exports = { webConfig, validateConfig, productionUrlError };
