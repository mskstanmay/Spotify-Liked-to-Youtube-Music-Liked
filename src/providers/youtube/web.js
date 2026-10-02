const { jsonResponse, ProviderError, providerFetch } = require('../http');
const { decryptSecret, encryptSecret } = require('../../auth/security');
const crypto = require('node:crypto');
const { sleep, withRetries } = require('../../utils/retry');
const { markConnectionHealth, ensureConnectionUsable } = require('../connectionHealth');

function authorizationUrl(config, state, challenge) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.google.clientId,
    redirect_uri: config.google.redirectUri,
    scope: config.google.scopes.join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  }).toString();
  return url.toString();
}

async function tokenRequest(config, params) {
  const response = await providerFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, ...params }),
    signal: AbortSignal.timeout(30_000),
  }, 'Google');
  return jsonResponse(response, 'Google');
}

function tokenRecord(token, config, previousRefreshToken = null) {
  return {
    encryptedAccessToken: encryptSecret(token.access_token, config.tokenEncryptionKey),
    encryptedRefreshToken: encryptSecret(token.refresh_token || previousRefreshToken, config.tokenEncryptionKey),
    expiresAt: new Date(Date.now() + (token.expires_in || 3600) * 1000),
    scopes: String(token.scope || config.google.scopes.join(' ')).split(' ').filter(Boolean),
  };
}

async function exchangeCode(config, code, verifier) {
  return tokenRequest(config, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.google.redirectUri,
    code_verifier: verifier,
  });
}

async function profile(accessToken) {
  const response = await providerFetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) }, 'Google');
  const body = await jsonResponse(response, 'Google');
  return { id: body.sub, name: body.name || null };
}

async function refreshAccessToken(prisma, connection, config) {
  ensureConnectionUsable(connection, 'YouTube');
  const originalVersion = connection.refreshVersion || 0;
  const owner = `refresh-${crypto.randomUUID()}`;
  const leaseMs = config.google.refreshLeaseMs || 35_000;
  const deadline = Date.now() + leaseMs * 2;

  while (Date.now() < deadline) {
    const fresh = await prisma.youTubeConnection.findUnique({ where: { id: connection.id } });
    if (!fresh) throw new ProviderError('YouTube Music needs to be connected again.', { provider: 'YouTube', authenticationRequired: true });
    if ((fresh.refreshVersion || 0) > originalVersion) {
      Object.assign(connection, fresh);
      return decryptSecret(fresh.encryptedAccessToken, config.tokenEncryptionKey);
    }

    const now = new Date();
    const claimed = await prisma.youTubeConnection.updateMany({
      where: {
        id: fresh.id,
        refreshVersion: fresh.refreshVersion || 0,
        OR: [{ refreshLockedUntil: null }, { refreshLockedUntil: { lt: now } }],
      },
      data: { refreshOwner: owner, refreshLockedUntil: new Date(Date.now() + leaseMs) },
    });
    if (!claimed.count) {
      await sleep(50);
      continue;
    }

    try {
      const refreshToken = decryptSecret(fresh.encryptedRefreshToken, config.tokenEncryptionKey);
      if (!refreshToken) {
        await markConnectionHealth(prisma, 'youTubeConnection', fresh, 'RECONNECT_REQUIRED', 'REFRESH_TOKEN_MISSING');
        throw new ProviderError('YouTube Music needs to be connected again.', { provider: 'YouTube', code: 'REFRESH_TOKEN_MISSING', authenticationRequired: true });
      }
      const token = await tokenRequest(config, { grant_type: 'refresh_token', refresh_token: refreshToken });
      const data = { ...tokenRecord(token, config, refreshToken), connectionStatus: 'ACTIVE', lastAuthErrorCode: null, authInvalidAt: null };
      const saved = await prisma.youTubeConnection.updateMany({
        where: { id: fresh.id, refreshOwner: owner, refreshVersion: fresh.refreshVersion || 0 },
        data: { ...data, refreshVersion: { increment: 1 }, refreshOwner: null, refreshLockedUntil: null },
      });
      if (!saved.count) throw new ProviderError('YouTube token refresh ownership was lost.', { provider: 'YouTube', code: 'TOKEN_REFRESH_FENCE_LOST', retryable: true });
      Object.assign(connection, data, { refreshVersion: (fresh.refreshVersion || 0) + 1, refreshOwner: null, refreshLockedUntil: null });
      return token.access_token;
    } catch (error) {
      await prisma.youTubeConnection.updateMany({ where: { id: fresh.id, refreshOwner: owner }, data: { refreshOwner: null, refreshLockedUntil: null } }).catch(() => {});
      if (error.authenticationRequired && error.code !== 'REFRESH_TOKEN_MISSING') {
        await markConnectionHealth(prisma, 'youTubeConnection', fresh, 'AUTHENTICATION_INVALID', error.code).catch(() => {});
      }
      throw error;
    }
  }
  throw new ProviderError('A concurrent YouTube token refresh did not finish in time.', { provider: 'YouTube', code: 'TOKEN_REFRESH_TIMEOUT', retryable: true });
}

async function validAccessToken(prisma, connection, config, { forceRefresh = false } = {}) {
  if (!connection) throw new ProviderError('YouTube Music needs to be connected again.', { provider: 'YouTube', authenticationRequired: true });
  ensureConnectionUsable(connection, 'YouTube');
  if (!forceRefresh && connection.expiresAt && connection.expiresAt.getTime() > Date.now() + 60_000) {
    return decryptSecret(connection.encryptedAccessToken, config.tokenEncryptionKey);
  }
  return refreshAccessToken(prisma, connection, config);
}

async function youtubeRequest(path, accessToken, options = {}) {
  const response = await providerFetch(`https://www.googleapis.com/youtube/v3${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${accessToken}`, ...(options.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  }, 'YouTube');
  if (response.status === 204) return {};
  return jsonResponse(response, 'YouTube');
}

async function authenticatedYouTubeRequest(prisma, connection, config, path, options = {}, beforeAttempt = () => {}) {
  let refreshedAfter401 = false;
  try {
    return await withRetries(async (attempt) => {
      await beforeAttempt(attempt);
      let token = await validAccessToken(prisma, connection, config);
      try {
        return await youtubeRequest(path, token, options);
      } catch (error) {
        if (error.status !== 401 || refreshedAfter401) throw error;
        token = await validAccessToken(prisma, connection, config, { forceRefresh: true });
        refreshedAfter401 = true;
        await beforeAttempt(attempt + 1);
        return youtubeRequest(path, token, options);
      }
    }, {
      retries: config.maxRetries,
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      shouldRetry: (error) => error.retryable === true && !error.quotaExceeded && !error.authenticationRequired,
    });
  } catch (error) {
    if (error.status === 401 || error.authenticationRequired) {
      const status = error.code === 'REFRESH_TOKEN_MISSING' || connection?.connectionStatus === 'RECONNECT_REQUIRED'
        ? 'RECONNECT_REQUIRED' : 'AUTHENTICATION_INVALID';
      await markConnectionHealth(prisma, 'youTubeConnection', connection, status, error.code).catch(() => {});
    }
    throw error;
  }
}

async function ratings(prisma, connection, config, videoIds, shouldContinue = () => {}) {
  if (!videoIds.length) return new Map();
  const values = new Map();
  for (let index = 0; index < videoIds.length; index += 50) {
    await shouldContinue();
    const ids = videoIds.slice(index, index + 50);
    const body = await authenticatedYouTubeRequest(prisma, connection, config, `/videos/getRating?id=${encodeURIComponent(ids.join(','))}`, {}, shouldContinue);
    for (const item of body.items || []) values.set(item.videoId, item.rating);
  }
  return values;
}

async function likeVideo(prisma, connection, config, videoId, beforeAttempt = () => {}) {
  await authenticatedYouTubeRequest(prisma, connection, config, `/videos/rate?id=${encodeURIComponent(videoId)}&rating=like`, { method: 'POST' }, beforeAttempt);
}

async function revokeConnection(connection, config) {
  if (!connection) return;
  let token;
  try {
    token = decryptSecret(connection.encryptedRefreshToken || connection.encryptedAccessToken, config.tokenEncryptionKey);
  } catch {
    return;
  }
  if (!token) return;
  await fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

module.exports = { authorizationUrl, exchangeCode, tokenRecord, profile, validAccessToken, refreshAccessToken, authenticatedYouTubeRequest, ratings, likeVideo, revokeConnection };
