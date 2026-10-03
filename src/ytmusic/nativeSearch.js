class NativeSearchError extends Error {
  constructor(message, { code = 'YTMUSIC_SEARCH_FAILED', retryable = true, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'NativeSearchError';
    this.code = code;
    this.retryable = retryable;
  }
}

function parseDuration(duration) {
  if (!duration || typeof duration !== 'string') return null;
  try {
    let seconds = 0;
    for (const part of duration.split(':')) {
      if (!/^\d+$/.test(part)) return null;
      seconds = (seconds * 60) + Number(part);
    }
    return seconds * 1000;
  } catch {
    return null;
  }
}

function normalizeArtists(artists) {
  if (!Array.isArray(artists)) return [];
  return artists.flatMap((artist) => {
    if (typeof artist === 'string' && artist) return [artist];
    if (artist && typeof artist === 'object' && artist.name) return [artist.name];
    return [];
  });
}

function textValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.toString === 'function') {
    const text = value.toString();
    return text === '[object Object]' ? null : text;
  }
  return null;
}

function videoType(item) {
  if (item?.videoType) return item.videoType;
  return item?.flex_columns?.at?.(0)?.title?.runs?.at?.(0)?.endpoint?.payload
    ?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType
    || null;
}

function isExplicit(item) {
  if (typeof item?.isExplicit === 'boolean') return item.isExplicit;
  if (!item?.badges) return null;
  const badgeText = Array.from(item.badges)
    .map((badge) => [badge?.label, badge?.icon_type, badge?.icon?.icon_type, textValue(badge?.text)].filter(Boolean).join(' '))
    .join(' ');
  return badgeText ? /explicit/i.test(badgeText) : null;
}

function normalizeResult(item, { resultType = null, category = null } = {}) {
  const duration = textValue(item?.duration);
  const album = item?.album && typeof item.album === 'object'
    ? textValue(item.album.name)
    : textValue(item?.album);
  const normalizedResultType = item?.resultType || resultType || item?.item_type || null;
  const artistSource = Array.isArray(item?.artists) && item.artists.length
    ? item.artists
    : item?.authors;
  const explicit = isExplicit(item);
  return {
    videoId: item?.videoId || item?.id || null,
    title: textValue(item?.title),
    artists: normalizeArtists(artistSource),
    album,
    duration,
    durationMs: parseDuration(duration),
    resultType: normalizedResultType,
    videoType: videoType(item),
    category: item?.category || category,
    isExplicit: explicit === null && normalizedResultType === 'song' ? false : explicit,
    feedbackTokens: item?.feedbackTokens || null,
    raw: item,
  };
}

function pageItems(page, resultType) {
  const namedShelf = page?.[resultType === 'song' ? 'songs' : 'videos'];
  if (namedShelf?.contents) return Array.from(namedShelf.contents);
  if (page?.contents?.contents) return Array.from(page.contents.contents);
  if (page?.contents && typeof page.contents[Symbol.iterator] === 'function') {
    const shelves = Array.from(page.contents);
    const expected = resultType === 'song' ? 'songs' : 'videos';
    const shelf = shelves.find((entry) => textValue(entry?.title)?.toLowerCase() === expected)
      || shelves.find((entry) => entry?.contents);
    if (shelf?.contents) return Array.from(shelf.contents);
  }
  return [];
}

async function collectFiltered(client, query, resultType, limit, runWithTimeout) {
  let page = await runWithTimeout(
    client.music.search(query, { type: resultType }),
    `YouTube Music ${resultType} search timed out.`,
  );
  const items = [];
  while (page && items.length < limit) {
    const current = pageItems(page, resultType);
    items.push(...current.slice(0, limit - items.length));
    if (items.length >= limit || !page.has_continuation || current.length === 0) break;
    page = await runWithTimeout(
      page.getContinuation(),
      `YouTube Music ${resultType} continuation timed out.`,
    );
  }
  return items;
}

function timeoutFetch(fetchImpl, timeoutMs) {
  return (input, init = {}) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([init.signal, timeoutSignal])
      : (init.signal || timeoutSignal);
    return fetchImpl(input, { ...init, signal });
  };
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new NativeSearchError(message, {
      code: 'YTMUSIC_SEARCH_TIMEOUT',
      retryable: true,
    })), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function defaultCreateClient(options) {
  const { Innertube } = await import('youtubei.js');
  return Innertube.create(options);
}

function createNativeSearch({
  limit = 10,
  timeoutMs = 30_000,
  createClient = defaultCreateClient,
  fetchImpl = globalThis.fetch,
} = {}) {
  const searchLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 10;
  const operationTimeoutMs = Number.isInteger(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 30_000;
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required for native YouTube Music search.');

  const runWithTimeout = (promise, message) => withTimeout(promise, operationTimeoutMs, message);

  return async function searchTrack(track) {
    const query = `${track?.title || ''} ${(track?.artists || []).join(' ')}`.trim();
    let client;
    try {
      client = await runWithTimeout(createClient({
        lang: 'en',
        retrieve_player: false,
        retrieve_innertube_config: false,
        generate_session_locally: true,
        enable_session_cache: false,
        fetch: timeoutFetch(fetchImpl, operationTimeoutMs),
      }), 'YouTube Music client initialization timed out.');
    } catch (error) {
      if (error instanceof NativeSearchError) throw error;
      throw new NativeSearchError('Could not initialize the YouTube Music search client.', {
        code: 'YTMUSIC_INITIALIZATION_FAILED',
        retryable: true,
        cause: error,
      });
    }

    try {
      const songs = await collectFiltered(client, query, 'song', searchLimit, runWithTimeout);
      const videos = await collectFiltered(client, query, 'video', searchLimit, runWithTimeout);
      const results = [];
      const seen = new Set();
      for (const [items, resultType, category] of [
        [songs, 'song', 'Songs'],
        [videos, 'video', 'Videos'],
      ]) {
        for (const item of items) {
          const normalized = normalizeResult(item, { resultType, category });
          if (!normalized.videoId || seen.has(normalized.videoId)) continue;
          seen.add(normalized.videoId);
          results.push(normalized);
        }
      }
      return results;
    } catch (error) {
      if (error instanceof NativeSearchError) throw error;
      throw new NativeSearchError('YouTube Music search failed.', {
        code: 'YTMUSIC_SEARCH_FAILED',
        retryable: true,
        cause: error,
      });
    }
  };
}

const searchTrack = createNativeSearch({
  limit: Number(process.env.YTMUSIC_SEARCH_LIMIT || 10),
  timeoutMs: Number(process.env.YTMUSIC_SEARCH_TIMEOUT_MS || 30_000),
});

module.exports = {
  NativeSearchError,
  parseDuration,
  normalizeArtists,
  normalizeResult,
  pageItems,
  collectFiltered,
  timeoutFetch,
  createNativeSearch,
  searchTrack,
};
