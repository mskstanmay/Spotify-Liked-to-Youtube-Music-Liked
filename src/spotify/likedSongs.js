const config = require('../config');
const { writeJson } = require('../utils/files');
const { getAccessToken, refreshAccessToken } = require('./auth');
const { sleep, withRetries } = require('../utils/retry');

function mapTrack(item) {
  const track = item.track || {};
  return {
    spotifyTrackId: track.id,
    title: track.name,
    artists: (track.artists || []).map((artist) => artist.name).filter(Boolean),
    album: track.album?.name || '',
    durationMs: track.duration_ms || 0,
    spotifyUrl: track.external_urls?.spotify || '',
    addedAt: item.added_at,
    isrc: track.external_ids?.isrc || '',
    popularity: track.popularity,
    explicit: track.explicit,
    raw: track,
  };
}

async function spotifyApi(path, tokenHolder) {
  const makeRequest = async () => {
    const response = await fetch(`https://api.spotify.com/v1${path}`, {
      headers: { Authorization: `Bearer ${tokenHolder.token.access_token}` },
    });

    if (response.status === 401) {
      tokenHolder.token = await refreshAccessToken(tokenHolder.token);
      const retry = await fetch(`https://api.spotify.com/v1${path}`, {
        headers: { Authorization: `Bearer ${tokenHolder.token.access_token}` },
      });
      return retry;
    }
    if (response.status >= 500) {
      const error = new Error(`Spotify API temporary error ${response.status}`);
      error.transient = true;
      throw error;
    }
    return response;
  };

  const response = await withRetries(makeRequest, {
    retries: config.sync.maxRetries,
    baseDelayMs: 800,
    shouldRetry: (error) => error.transient === true,
  });

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after') || 1);
    await sleep(retryAfter * 1000);
    return spotifyApi(path, tokenHolder);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Spotify API error (${response.status}): ${body.error?.message || 'unknown error'}`);
  }
  return body;
}

async function fetchAllLikedSongs({ persist = true, onProgress = () => {} } = {}) {
  const tokenHolder = { token: await getAccessToken() };
  const limit = 50;
  let offset = 0;
  let total = null;
  const tracks = [];

  while (total === null || offset < total) {
    const page = await spotifyApi(`/me/tracks?limit=${limit}&offset=${offset}`, tokenHolder);
    total = page.total || 0;
    const items = Array.isArray(page.items) ? page.items : [];
    tracks.push(...items.map(mapTrack).filter((track) => track.spotifyTrackId && track.title));
    offset += items.length;
    onProgress(tracks.length, total);
    if (items.length === 0) break;
  }

  const payload = {
    fetchedAt: new Date().toISOString(),
    total: tracks.length,
    tracks,
  };

  if (persist) {
    await writeJson(config.spotify.libraryPath, payload);
  }

  return payload;
}

module.exports = { fetchAllLikedSongs };
