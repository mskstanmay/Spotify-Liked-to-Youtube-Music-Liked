const { jsonResponse, ProviderError, providerFetch } = require('../http');
const { decryptSecret, encryptSecret } = require('../../auth/security');
const { sleep, withRetries } = require('../../utils/retry');
const { markConnectionHealth, ensureConnectionUsable } = require('../connectionHealth');

function authorizationUrl(config, state, challenge) {
  const url = new URL('https://accounts.spotify.com/authorize');
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.spotify.clientId,
    redirect_uri: config.spotify.redirectUri,
    scope: config.spotify.scope,
    state,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  }).toString();
  return url.toString();
}

async function tokenRequest(config, params) {
  const response = await providerFetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.spotify.clientId, ...params }),
    signal: AbortSignal.timeout(30_000),
  }, 'Spotify');
  return jsonResponse(response, 'Spotify');
}

function tokenRecord(token, config, previousRefreshToken = null) {
  return {
    encryptedAccessToken: encryptSecret(token.access_token, config.tokenEncryptionKey),
    encryptedRefreshToken: encryptSecret(token.refresh_token || previousRefreshToken, config.tokenEncryptionKey),
    expiresAt: new Date(Date.now() + (token.expires_in || 3600) * 1000),
    scopes: String(token.scope || config.spotify.scope).split(' ').filter(Boolean),
  };
}

async function exchangeCode(config, code, verifier) {
  return tokenRequest(config, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.spotify.redirectUri,
    code_verifier: verifier,
  });
}

async function spotifyFetch(path, accessToken) {
  const response = await providerFetch(`https://api.spotify.com/v1${path}`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) }, 'Spotify');
  return jsonResponse(response, 'Spotify');
}

async function profile(accessToken, config = { maxRetries: 3 }) {
  const body = await withRetries(() => spotifyFetch('/me', accessToken), {
    retries: config.maxRetries,
    baseDelayMs: 800,
    maxDelayMs: 60_000,
    shouldRetry: (error) => error.retryable === true,
  });
  if (!body.account_id) {
    throw new ProviderError('Spotify did not return a stable account identifier.', {
      provider: 'Spotify',
      code: 'SPOTIFY_ACCOUNT_ID_MISSING',
      authenticationRequired: true,
    });
  }
  return { id: body.account_id, name: body.display_name || null };
}

async function validAccessToken(prisma, connection, config) {
  if (!connection) throw new ProviderError('Spotify needs to be connected again.', { provider: 'Spotify', authenticationRequired: true });
  ensureConnectionUsable(connection, 'Spotify');
  if (connection.expiresAt && connection.expiresAt.getTime() > Date.now() + 60_000) {
    return decryptSecret(connection.encryptedAccessToken, config.tokenEncryptionKey);
  }
  const refreshToken = decryptSecret(connection.encryptedRefreshToken, config.tokenEncryptionKey);
  if (!refreshToken) {
    await markConnectionHealth(prisma, 'spotifyConnection', connection, 'RECONNECT_REQUIRED', 'REFRESH_TOKEN_MISSING');
    throw new ProviderError('Spotify needs to be connected again.', { provider: 'Spotify', code: 'REFRESH_TOKEN_MISSING', authenticationRequired: true });
  }
  let token;
  try {
    token = await tokenRequest(config, { grant_type: 'refresh_token', refresh_token: refreshToken });
  } catch (error) {
    if (error.authenticationRequired) await markConnectionHealth(prisma, 'spotifyConnection', connection, 'AUTHENTICATION_INVALID', error.code);
    throw error;
  }
  const data = { ...tokenRecord(token, config, refreshToken), connectionStatus: 'ACTIVE', lastAuthErrorCode: null, authInvalidAt: null };
  await prisma.spotifyConnection.update({ where: { id: connection.id }, data });
  Object.assign(connection, data);
  return token.access_token;
}

function mapTrack(item) {
  const track = item.track || {};
  return {
    spotifyTrackId: track.id,
    title: track.name,
    artists: (track.artists || []).map((artist) => artist.name).filter(Boolean),
    album: track.album?.name || '',
    durationMs: track.duration_ms || 0,
    spotifyUrl: track.external_urls?.spotify || '',
  };
}

async function fetchLikedTracks(prisma, connection, config, onProgress = () => {}, shouldContinue = () => {}, trackLimit = null, onRetry = () => {}) {
  let accessToken = await validAccessToken(prisma, connection, config);
  let offset = 0;
  let total = null;
  const tracks = [];
  while ((total === null || offset < total) && (!trackLimit || tracks.length < trackLimit)) {
    const pageLimit = Math.min(50, trackLimit ? Math.max(1, trackLimit - tracks.length) : 50);
    const request = async () => {
      shouldContinue();
      try {
        return await spotifyFetch(`/me/tracks?limit=${pageLimit}&offset=${offset}`, accessToken);
      } catch (error) {
        if (error.status === 401) {
          const fresh = await prisma.spotifyConnection.findUnique({ where: { id: connection.id } });
          fresh.expiresAt = new Date(0);
          accessToken = await validAccessToken(prisma, fresh, config);
          try {
            return await spotifyFetch(`/me/tracks?limit=${pageLimit}&offset=${offset}`, accessToken);
          } catch (retryError) {
            if (retryError.status === 401) await markConnectionHealth(prisma, 'spotifyConnection', fresh, 'AUTHENTICATION_INVALID', retryError.code);
            throw retryError;
          }
        }
        throw error;
      }
    };
    const page = await withRetries(request, {
      retries: config.maxRetries,
      baseDelayMs: 800,
      shouldRetry: (error) => error.retryable === true,
      onRetry,
    });
    total = page.total || 0;
    const items = page.items || [];
    const mapped = items.map(mapTrack).filter((track) => track.spotifyTrackId && track.title);
    tracks.push(...(trackLimit ? mapped.slice(0, Math.max(0, trackLimit - tracks.length)) : mapped));
    offset += items.length;
    await onProgress(tracks.length, trackLimit ? Math.min(total, trackLimit) : total, total);
    if (!items.length) break;
    await sleep(25);
  }
  return { tracks, sourceTotal: total || 0 };
}

module.exports = { authorizationUrl, exchangeCode, tokenRecord, profile, validAccessToken, fetchLikedTracks };
