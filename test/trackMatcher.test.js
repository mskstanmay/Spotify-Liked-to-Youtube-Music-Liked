const test = require('node:test');
const assert = require('node:assert/strict');
const { matchTrack, normalizeString } = require('../src/matching/trackMatcher');

function spotify(overrides = {}) {
  return {
    spotifyTrackId: 'sp1',
    title: 'Blinding Lights',
    artists: ['The Weeknd'],
    album: 'After Hours',
    durationMs: 200000,
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    videoId: 'yt1',
    title: 'Blinding Lights',
    artists: ['The Weeknd'],
    album: 'After Hours',
    durationMs: 201000,
    resultType: 'song',
    videoType: 'MUSIC_VIDEO_TYPE_ATV',
    ...overrides,
  };
}

test('exact title and artist match is high confidence', () => {
  const result = matchTrack(spotify(), [candidate()]);
  assert.equal(result.matched, true);
  assert.equal(result.confidence, 'HIGH');
});

test('official audio text does not block a normal match', () => {
  const result = matchTrack(spotify(), [candidate({ title: 'Blinding Lights (Official Audio)' })]);
  assert.equal(result.matched, true);
});

test('different artist is not high confidence', () => {
  const result = matchTrack(spotify(), [candidate({ artists: ['Someone Else'] })]);
  assert.equal(result.matched, false);
});

test('live version is not selected for studio track', () => {
  const result = matchTrack(spotify(), [candidate({ title: 'Blinding Lights (Live)' })]);
  assert.equal(result.matched, false);
  assert.match(result.reason, /version/i);
});

test('remix is not selected for original track', () => {
  const result = matchTrack(spotify(), [candidate({ title: 'Blinding Lights Remix' })]);
  assert.equal(result.matched, false);
});

test('large duration mismatch lowers confidence', () => {
  const result = matchTrack(spotify(), [candidate({ durationMs: 260000 })]);
  assert.equal(result.matched, false);
});

test('multiple artists can match a collaboration', () => {
  const result = matchTrack(
    spotify({ title: 'Starboy', artists: ['The Weeknd', 'Daft Punk'] }),
    [candidate({ title: 'Starboy', artists: ['The Weeknd', 'Daft Punk'] })],
  );
  assert.equal(result.matched, true);
});

test('punctuation differences normalize away', () => {
  assert.equal(normalizeString('Sweet Child O\' Mine!'), normalizeString('sweet child o mine'));
  const result = matchTrack(
    spotify({ title: 'Sweet Child O\' Mine', artists: ['Guns N Roses'] }),
    [candidate({ title: 'Sweet Child O Mine', artists: ['Guns N Roses'] })],
  );
  assert.equal(result.matched, true);
});

test('case differences normalize away', () => {
  const result = matchTrack(spotify({ title: 'BLINDING LIGHTS' }), [candidate({ title: 'blinding lights' })]);
  assert.equal(result.matched, true);
});

test('low-confidence match is left for review', () => {
  const result = matchTrack(
    spotify({ title: 'A Rare Song', artists: ['Known Artist'], durationMs: 180000 }),
    [candidate({ title: 'Rare Song Cover Live', artists: ['Unknown Artist'], durationMs: 230000, resultType: 'video' })],
  );
  assert.equal(result.matched, false);
  assert.equal(result.confidence, 'LOW');
});
