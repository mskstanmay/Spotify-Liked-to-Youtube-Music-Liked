const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/ytmusic-search/candidates.json');
const {
  createNativeSearch,
  normalizeResult,
  parseDuration,
} = require('../src/ytmusic/nativeSearch');
const { MigrationWorker } = require('../src/worker/migrationWorker');

function continuationPage(pages, index, continuationCalls) {
  return {
    contents: { contents: pages[index] || [] },
    has_continuation: index + 1 < pages.length,
    async getContinuation() {
      continuationCalls.push(index + 1);
      return continuationPage(pages, index + 1, continuationCalls);
    },
  };
}

function initialPage(pages, type, continuationCalls) {
  const property = type === 'song' ? 'songs' : 'videos';
  return {
    [property]: { contents: pages[0] || [] },
    has_continuation: pages.length > 1,
    async getContinuation() {
      continuationCalls.push(1);
      return continuationPage(pages, 1, continuationCalls);
    },
  };
}

function fakeClient({ calls, continuationCalls }) {
  return {
    music: {
      async search(query, { type }) {
        calls.push({ query, type });
        const pages = type === 'song' ? fixture.songPages : fixture.videoPages;
        return initialPage(pages, type, continuationCalls[type]);
      },
    },
  };
}

test('native search queries songs before videos, paginates to each independent limit, and preserves ordering', async () => {
  const calls = [];
  const continuationCalls = { song: [], video: [] };
  const searchTrack = createNativeSearch({
    limit: 4,
    createClient: async () => fakeClient({ calls, continuationCalls }),
  });
  const results = await searchTrack({ title: 'Fixture Song', artists: ['First Artist', 'Second Artist'] });

  assert.deepEqual(calls, [
    { query: 'Fixture Song First Artist Second Artist', type: 'song' },
    { query: 'Fixture Song First Artist Second Artist', type: 'video' },
  ]);
  assert.deepEqual(continuationCalls, { song: [1], video: [1] });
  assert.deepEqual(results.map((candidate) => candidate.videoId), ['song-a', 'shared', 'song-c', 'video-b', 'video-c']);
  assert.equal(results.some((candidate) => candidate.videoId === 'song-over-limit'), false);
  assert.equal(results.find((candidate) => candidate.videoId === 'shared').title, 'Shared Song Result');
});

test('native search applies the limit independently without requesting unnecessary continuations', async () => {
  const calls = [];
  const continuationCalls = { song: [], video: [] };
  const searchTrack = createNativeSearch({
    limit: 2,
    createClient: async () => fakeClient({ calls, continuationCalls }),
  });
  const results = await searchTrack({ title: 'Limited', artists: ['Artist'] });
  assert.deepEqual(continuationCalls, { song: [], video: [] });
  assert.deepEqual(results.map((candidate) => candidate.videoId), ['song-a', 'shared', 'video-b']);
});

test('candidate normalization matches the existing matcher contract', () => {
  const song = fixture.songPages[0][0];
  const normalizedSong = normalizeResult(song, { resultType: 'song', category: 'Songs' });
  assert.deepEqual(Object.keys(normalizedSong), [
    'videoId', 'title', 'artists', 'album', 'duration', 'durationMs', 'resultType',
    'videoType', 'category', 'isExplicit', 'feedbackTokens', 'raw',
  ]);
  assert.equal(normalizedSong.videoId, 'song-a');
  assert.deepEqual(normalizedSong.artists, ['Fixture Artist']);
  assert.equal(normalizedSong.album, 'Fixture Album');
  assert.equal(normalizedSong.duration, '3:01');
  assert.equal(normalizedSong.durationMs, 181_000);
  assert.equal(normalizedSong.resultType, 'song');
  assert.equal(normalizedSong.videoType, 'MUSIC_VIDEO_TYPE_ATV');
  assert.equal(normalizedSong.category, 'Songs');
  assert.equal(normalizedSong.isExplicit, true);
  assert.deepEqual(normalizedSong.feedbackTokens, { add: 'sanitized-add-token' });
  assert.equal(normalizedSong.raw, song);

  const video = normalizeResult(fixture.videoPages[0][1], { resultType: 'video', category: 'Videos' });
  assert.deepEqual(video.artists, ['Video Author']);
  assert.equal(video.album, null);
  assert.equal(video.durationMs, null);

  const missing = normalizeResult({}, { resultType: 'video', category: 'Videos' });
  assert.deepEqual(missing, {
    videoId: null,
    title: null,
    artists: [],
    album: null,
    duration: null,
    durationMs: null,
    resultType: 'video',
    videoType: null,
    category: 'Videos',
    isExplicit: null,
    feedbackTokens: null,
    raw: {},
  });
});

test('duration parsing supports M:SS and H:MM:SS and rejects missing or invalid values', () => {
  assert.equal(parseDuration('3:01'), 181_000);
  assert.equal(parseDuration('1:02:03'), 3_723_000);
  assert.equal(parseDuration('bad'), null);
  assert.equal(parseDuration(null), null);
});

test('native search times out stalled provider operations with a retryable error', async () => {
  const searchTrack = createNativeSearch({
    timeoutMs: 10,
    createClient: async () => ({ music: { search: () => new Promise(() => {}) } }),
  });
  await assert.rejects(
    () => searchTrack({ title: 'Timeout', artists: [] }),
    (error) => error.code === 'YTMUSIC_SEARCH_TIMEOUT' && error.retryable === true,
  );
});

test('client initialization failures are structured and a later call initializes again', async () => {
  let attempts = 0;
  const calls = [];
  const continuationCalls = { song: [], video: [] };
  const searchTrack = createNativeSearch({
    createClient: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('initialization failed');
      return fakeClient({ calls, continuationCalls });
    },
  });
  await assert.rejects(
    () => searchTrack({ title: 'Retry initialization', artists: [] }),
    (error) => error.code === 'YTMUSIC_INITIALIZATION_FAILED' && error.retryable === true,
  );
  await searchTrack({ title: 'Retry initialization', artists: [] });
  assert.equal(attempts, 2);
});

test('native search initializes anonymously without OAuth credentials or cookies', async () => {
  let options;
  const calls = [];
  const continuationCalls = { song: [], video: [] };
  const searchTrack = createNativeSearch({
    limit: 1,
    createClient: async (received) => {
      options = received;
      return fakeClient({ calls, continuationCalls });
    },
  });
  await searchTrack({ title: 'Anonymous', artists: ['Search'] });
  assert.equal(options.cookie, undefined);
  assert.equal(options.oauth, undefined);
  assert.equal(options.credentials, undefined);
  assert.equal(options.retrieve_player, false);
  assert.equal(options.generate_session_locally, true);
  assert.equal(options.enable_session_cache, false);
  assert.equal(typeof options.fetch, 'function');
});

test('MigrationWorker uses an injected native search provider without loading the legacy bridge', () => {
  const nativeSearch = async () => [];
  const worker = new MigrationWorker({
    prisma: {},
    config: { workerLeaseMs: 60_000 },
    providers: { searchTrack: nativeSearch },
  });
  assert.equal(worker.searchTrack, nativeSearch);
});
