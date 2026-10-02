const path = require('node:path');
require('dotenv').config({ quiet: true });

const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolFromEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

module.exports = {
  rootDir,
  dataDir,
  spotify: {
    clientId: process.env.SPOTIFY_CLIENT_ID || '',
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
    redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:8888/callback',
    scope: 'user-library-read',
    tokenPath: path.join(dataDir, 'spotify-token.json'),
    libraryPath: path.join(dataDir, 'spotify-liked.json'),
  },
  ytmusic: {
    authPath: process.env.YTMUSIC_AUTH_PATH || path.join(dataDir, 'ytmusic-oauth.json'),
    browserAuthPath: process.env.YTMUSIC_BROWSER_AUTH_PATH || path.join(dataDir, 'ytmusic-browser.json'),
    clientId: process.env.YTMUSIC_CLIENT_ID || '',
    clientSecret: process.env.YTMUSIC_CLIENT_SECRET || '',
    searchLimit: numberFromEnv('YTMUSIC_SEARCH_LIMIT', 10),
    likedSongsLimit: numberFromEnv('YTMUSIC_LIKED_SONGS_LIMIT', 10000),
    subprocessTimeoutMs: Math.max(1, numberFromEnv('PYTHON_SUBPROCESS_TIMEOUT_MS', 30_000)),
    authTimeoutMs: Math.max(1, numberFromEnv('YTMUSIC_AUTH_TIMEOUT_MS', 10 * 60 * 1000)),
  },
  sync: {
    resultsPath: path.join(dataDir, 'sync-results.json'),
    reviewPath: path.join(dataDir, 'review.json'),
    confidenceThreshold: numberFromEnv('MATCH_CONFIDENCE_THRESHOLD', 0.85),
    requestDelayMs: numberFromEnv('REQUEST_DELAY_MS', 250),
    maxRetries: numberFromEnv('MAX_RETRIES', 3),
    debug: boolFromEnv('DEBUG_SYNC', false),
  },
};
