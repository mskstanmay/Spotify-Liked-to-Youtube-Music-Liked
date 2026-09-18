const config = require('../config');
const { readJson, writeJson } = require('../utils/files');
const { fetchAllLikedSongs } = require('../spotify/likedSongs');
const ytmusic = require('../ytmusic/client');
const { matchTrack } = require('../matching/trackMatcher');
const { sleep, withRetries } = require('../utils/retry');
const { renderProgress } = require('../utils/progress');
const log = require('../utils/logger');

const COMPLETED_STATUSES = new Set(['liked', 'already_liked', 'not_found', 'ambiguous']);

function isRetryableError(error) {
  const message = String(error?.message || '');
  if (message.includes('HTTP 400') || message.includes('Bad Request')) return false;
  return true;
}

async function loadSpotifyLibrary({ refresh = false } = {}) {
  if (!refresh) {
    const cached = await readJson(config.spotify.libraryPath, null);
    if (cached?.tracks?.length) return cached;
  }

  log.line('Fetching Spotify liked songs...');
  return fetchAllLikedSongs({
    persist: true,
    onProgress: (count, total) => log.line(`Fetched ${count}/${total || '?'} Spotify tracks...`),
  });
}

async function loadResults() {
  return readJson(config.sync.resultsPath, {
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tracks: {},
  });
}

async function saveResults(results) {
  results.updatedAt = new Date().toISOString();
  await writeJson(config.sync.resultsPath, results);
}

async function loadReview() {
  return readJson(config.sync.reviewPath, {
    updatedAt: new Date().toISOString(),
    items: [],
  });
}

async function saveReview(review) {
  review.updatedAt = new Date().toISOString();
  await writeJson(config.sync.reviewPath, review);
}

function summarize(results) {
  const counts = {
    matched: 0,
    liked: 0,
    already_liked: 0,
    ambiguous: 0,
    not_found: 0,
    failed: 0,
    skipped: 0,
  };
  for (const record of Object.values(results.tracks || {})) {
    if (counts[record.status] !== undefined) counts[record.status] += 1;
  }
  return counts;
}

function recordFor(track, status, extra = {}) {
  return {
    spotifyTrackId: track.spotifyTrackId,
    title: track.title,
    artists: track.artists,
    album: track.album,
    status,
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

function shouldProcess(existing, options) {
  if (options.force) return true;
  if (options.retryFailed) return existing?.status === 'failed';
  if (!existing) return true;
  if (existing.status === 'failed') return true;
  return !COMPLETED_STATUSES.has(existing.status);
}

async function processTrack(track, options, likedVideoIds) {
  let candidates;
  try {
    candidates = await withRetries(() => ytmusic.searchTrack(track), {
      retries: config.sync.maxRetries,
      baseDelayMs: 700,
      shouldRetry: isRetryableError,
      onRetry: (error, attempt) => log.debug(`Retrying YouTube Music search for ${track.title}, attempt ${attempt}`, error.message),
    });
  } catch (error) {
    throw new Error(`YouTube Music search failed: ${error.message}`);
  }

  if (!candidates.length) {
    return recordFor(track, 'not_found', { match: null, candidates: [] });
  }

  const match = matchTrack(track, candidates, { threshold: config.sync.confidenceThreshold });
  if (!match.matched) {
    return recordFor(track, 'ambiguous', { match, candidates: match.candidates });
  }

  if (likedVideoIds?.has(match.videoId)) {
    return recordFor(track, 'already_liked', { match });
  }

  if (options.dryRun) {
    return recordFor(track, 'matched', { match });
  }

  try {
    await withRetries(() => ytmusic.likeTrack(match.videoId), {
      retries: config.sync.maxRetries,
      baseDelayMs: 900,
      shouldRetry: isRetryableError,
      onRetry: (error, attempt) => log.debug(`Retrying YouTube Music like for ${match.videoId}, attempt ${attempt}`, error.message),
    });
  } catch (error) {
    throw new Error(`YouTube Music like failed for videoId ${match.videoId}: ${error.message}`);
  }
  likedVideoIds?.add(match.videoId);
  return recordFor(track, 'liked', { match });
}

async function syncLibrary(options = {}) {
  const normalizedOptions = {
    refreshSpotify: false,
    dryRun: false,
    retryFailed: false,
    force: false,
    limit: null,
    fromIndex: null,
    ...options,
  };

  log.line('Spotify -> YouTube Music Liked Songs');
  log.line('');

  const library = await loadSpotifyLibrary({ refresh: normalizedOptions.refreshSpotify || normalizedOptions.force });
  const tracks = library.tracks || [];
  log.line(`Found ${tracks.length} Spotify liked tracks.`);

  const results = normalizedOptions.force ? { startedAt: new Date().toISOString(), tracks: {} } : await loadResults();
  const review = normalizedOptions.force ? { items: [] } : await loadReview();
  const reviewById = new Map((review.items || []).map((item) => [item.spotifyTrack.spotifyTrackId, item]));

  let likedVideoIds = new Set();
  if (!normalizedOptions.dryRun) {
    try {
      likedVideoIds = await ytmusic.getLikedVideoIds();
      log.line(`Loaded ${likedVideoIds.size} existing YouTube Music liked IDs.`);
    } catch (error) {
      log.failed(`Could not preload YouTube Music liked IDs; continuing without already-liked detection. ${error.message}`);
    }
  }

  const startIndex = normalizedOptions.fromIndex ? normalizedOptions.fromIndex - 1 : 0;
  const selectedTracks = tracks
    .map((track, index) => ({ track, index }))
    .filter((entry) => entry.index >= startIndex)
    .slice(0, normalizedOptions.limit || undefined);

  for (const entry of selectedTracks) {
    const { track } = entry;
    const processed = entry.index + 1;
    const existing = results.tracks[track.spotifyTrackId];
    if (!shouldProcess(existing, normalizedOptions)) {
      log.skipped(`${renderProgress(processed, tracks.length)} ${track.title} - ${track.artists.join(', ')}`);
      continue;
    }

    log.line('');
    log.line(renderProgress(processed, tracks.length));
    log.line(`Current: ${track.title} - ${track.artists.join(', ')}`);

    try {
      const record = await processTrack(track, normalizedOptions, likedVideoIds);
      results.tracks[track.spotifyTrackId] = record;

      if (record.status === 'ambiguous') {
        reviewById.set(track.spotifyTrackId, {
          spotifyTrack: track,
          match: record.match,
          candidates: record.candidates,
          reason: record.match?.reason || 'Review needed.',
          updatedAt: record.updatedAt,
        });
        log.review(`${track.title} (${record.match?.reason || 'ambiguous'})`);
      } else if (record.status === 'not_found') {
        log.failed(`${track.title} not found`);
      } else if (record.status === 'already_liked') {
        log.skipped(`${track.title} already liked`);
      } else if (record.status === 'matched') {
        log.success(`${track.title} matched in dry run (${record.match.confidence} ${record.match.score})`);
      } else {
        log.success(`${track.title} liked (${record.match.confidence} ${record.match.score})`);
      }
    } catch (error) {
      results.tracks[track.spotifyTrackId] = recordFor(track, 'failed', { error: error.message });
      log.failed(`${track.title}: ${error.message}`);
    }

    await saveResults(results);
    review.items = [...reviewById.values()];
    await saveReview(review);
    await sleep(config.sync.requestDelayMs);
  }

  const counts = summarize(results);
  log.line('');
  log.line('Synchronization complete.');
  log.line(`Total Spotify liked songs: ${tracks.length}`);
  if (normalizedOptions.dryRun) log.line(`Matched:        ${counts.matched}`);
  log.line(`Liked:          ${counts.liked}`);
  log.line(`Already liked:  ${counts.already_liked}`);
  log.line(`Review needed:  ${counts.ambiguous}`);
  log.line(`Not found:      ${counts.not_found}`);
  log.line(`Failed:         ${counts.failed}`);
  return { counts, total: tracks.length };
}

async function showReview() {
  const review = await loadReview();
  const items = review.items || [];
  if (!items.length) {
    log.line('No review items found.');
    return;
  }
  for (const item of items) {
    log.line('');
    log.line(`${item.spotifyTrack.title} - ${item.spotifyTrack.artists.join(', ')}`);
    log.line(`Reason: ${item.reason}`);
    for (const candidate of (item.candidates || []).slice(0, 5)) {
      log.line(`  ${candidate.score} ${candidate.title} - ${(candidate.artists || []).join(', ')} [${candidate.videoId}]`);
    }
  }
}

module.exports = {
  syncLibrary,
  loadSpotifyLibrary,
  showReview,
};
