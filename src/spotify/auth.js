const http = require('node:http');
const { URL } = require('node:url');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const config = require('../config');
const { ensureDir, readJson, writeJson } = require('../utils/files');

function requireSpotifyCredentials() {
  if (!config.spotify.clientId || !config.spotify.clientSecret) {
    throw new Error('Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET in .env.');
  }
}

function openBrowser(url) {
  const command = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];

  try {
    const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore', shell: false });
    child.unref();
  } catch {
    process.stdout.write(`Open this URL in your browser:\n${url}\n`);
  }
}

function basicAuthHeader() {
  return `Basic ${Buffer.from(`${config.spotify.clientId}:${config.spotify.clientSecret}`).toString('base64')}`;
}

async function tokenRequest(params) {
  requireSpotifyCredentials();
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Spotify token request failed (${response.status}): ${body.error_description || body.error || 'unknown error'}`);
  }

  return {
    ...body,
    createdAt: Date.now(),
    expiresAt: Date.now() + ((body.expires_in || 3600) * 1000),
  };
}

async function saveToken(token) {
  await ensureDir(config.dataDir);
  await writeJson(config.spotify.tokenPath, token);
}

async function loadToken() {
  return readJson(config.spotify.tokenPath, null);
}

async function refreshAccessToken(token) {
  if (!token?.refresh_token) {
    throw new Error('Spotify token is missing refresh_token. Run `npm run auth:spotify`.');
  }

  const refreshed = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
  });

  const merged = {
    ...token,
    ...refreshed,
    refresh_token: refreshed.refresh_token || token.refresh_token,
  };
  await saveToken(merged);
  return merged;
}

async function getAccessToken() {
  const token = await loadToken();
  if (!token) {
    return authenticateSpotify();
  }

  if ((token.expiresAt || 0) - Date.now() < 60_000) {
    return refreshAccessToken(token);
  }
  return token;
}

function waitForCallback(expectedState) {
  const redirectUrl = new URL(config.spotify.redirectUri);
  const port = Number(redirectUrl.port || (redirectUrl.protocol === 'https:' ? 443 : 80));
  const host = redirectUrl.hostname;
  const callbackPath = redirectUrl.pathname;

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, config.spotify.redirectUri);
      if (reqUrl.pathname !== callbackPath) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = reqUrl.searchParams.get('code');
      const state = reqUrl.searchParams.get('state');
      const error = reqUrl.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(`Spotify authorization failed: ${error}`);
        server.close();
        reject(new Error(`Spotify authorization failed: ${error}`));
        return;
      }

      if (!code || state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid Spotify callback.');
        server.close();
        reject(new Error('Invalid Spotify callback state or code.'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Spotify authorization complete. You can return to the terminal.');
      server.close();
      resolve(code);
    });

    server.on('error', reject);
    server.listen(port, host);
  });
}

async function authenticateSpotify() {
  requireSpotifyCredentials();
  const state = crypto.randomBytes(16).toString('hex');
  const authUrl = new URL('https://accounts.spotify.com/authorize');
  authUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.spotify.clientId,
    scope: config.spotify.scope,
    redirect_uri: config.spotify.redirectUri,
    state,
  }).toString();

  process.stdout.write(`Spotify authorization URL:\n${authUrl.toString()}\n`);
  openBrowser(authUrl.toString());

  const code = await waitForCallback(state);
  const token = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.spotify.redirectUri,
  });
  await saveToken(token);
  return token;
}

module.exports = {
  authenticateSpotify,
  getAccessToken,
  refreshAccessToken,
};
