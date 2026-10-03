const test = require('node:test');
const assert = require('node:assert/strict');
const { matchTrack, normalizeString } = require('../src/matching/trackMatcher');
const { scanResultData } = require('../src/worker/migrationWorker');

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

test('genuinely close weighted candidates remain unmatched and expose explicit ambiguity metadata', () => {
  const result = matchTrack(spotify(), [
    candidate({ videoId: 'first', durationMs: 195000 }),
    candidate({ videoId: 'second', durationMs: 205000 }),
  ]);
  assert.equal(result.matched, false);
  assert.equal(result.closeSecond, true);
  assert.equal(result.confidence, 'MEDIUM');
  assert.equal(result.matchTier, 'WEIGHTED');
});

test('medium confidence does not change shared matcher or CLI acceptance semantics', () => {
  const result = matchTrack(
    spotify(),
    [candidate({ durationMs: 260000, resultType: 'video', videoType: 'MUSIC_VIDEO_TYPE_UGC' })],
  );
  assert.equal(result.confidence, 'MEDIUM');
  assert.equal(result.matched, false);
  assert.equal(result.closeSecond, false);
});

test('real Take My Mind candidates select the ATV song without a false close second', () => {
  const source = spotify({
    title: 'Take My Mind',
    artists: ['WizTheMc', 'bees & honey'],
    album: 'YEBO',
    durationMs: 171199,
  });
  const result = matchTrack(source, [
    candidate({
      videoId: 'UAepuqX-StE',
      title: 'Take My Mind',
      artists: ['WizTheMc', 'bees & honey'],
      album: null,
      durationMs: 172000,
      resultType: 'video',
      videoType: 'MUSIC_VIDEO_TYPE_OMV',
    }),
    candidate({
      videoId: 'ukxikZCIRBU',
      title: 'Take My Mind',
      artists: ['WizTheMc', 'bees & honey'],
      album: 'Take My Mind',
      durationMs: 172000,
      resultType: 'song',
      videoType: 'MUSIC_VIDEO_TYPE_ATV',
    }),
  ]);

  assert.equal(result.matched, true);
  assert.equal(result.videoId, 'ukxikZCIRBU');
  assert.equal(result.score, 0.92);
  assert.equal(result.confidence, 'HIGH');
  assert.equal(result.matchTier, 'EXACT');
  assert.equal(result.closeSecond, false);
  assert.deepEqual(scanResultData(result), {
    status: 'READY', needsReview: false,
    matchedYoutubeVideoId: 'ukxikZCIRBU', matchedYoutubeTitle: 'Take My Mind',
    matchedYoutubeArtists: ['WizTheMc', 'bees & honey'], confidence: 'HIGH', score: 0.92, reason: null,
  });
});

test('one-second and inclusive three-second duration differences qualify for exact evidence', () => {
  for (const durationMs of [172000, 174000]) {
    const result = matchTrack(
      spotify({ title: 'Boundary', artists: ['Artist'], durationMs: 171000 }),
      [candidate({ title: 'Boundary', artists: ['Artist'], durationMs })],
    );
    assert.equal(result.matched, true);
    assert.equal(result.matchTier, 'EXACT');
    assert.equal(result.selectedCandidate.scoreBreakdown.duration, 1);
  }
});

test('a 3001 ms duration difference uses weighted fallback', () => {
  const result = matchTrack(
    spotify({ title: 'Boundary', artists: ['Artist'], durationMs: 171000 }),
    [candidate({ title: 'Boundary', artists: ['Artist'], durationMs: 174001 })],
  );
  assert.equal(result.matchTier, 'WEIGHTED');
  assert.equal(result.selectedCandidate.scoreBreakdown.duration, 0.85);
});

test('exact title with a different artist never enters the exact tier', () => {
  const result = matchTrack(spotify(), [candidate({ artists: ['Someone Else'] })]);
  assert.equal(result.matched, false);
  assert.equal(result.matchTier, 'WEIGHTED');
  assert.ok(result.selectedCandidate.reasons.includes('artist mismatch'));
});

test('material version differences remain in review', () => {
  for (const version of [
    'Live', 'Remix', 'Rework', 'Radio Edit', 'Extended', 'Acoustic', 'Unplugged',
    'Instrumental', 'Karaoke', 'Cover', 'Tribute', 'Sped Up', 'Slowed', '2020 Remastered',
  ]) {
    const result = matchTrack(spotify(), [candidate({ title: `Blinding Lights (${version})` })]);
    assert.equal(result.matched, false, version);
    assert.equal(result.matchTier, 'WEIGHTED', version);
    assert.ok(result.selectedCandidate.reasons.includes('version mismatch'), version);
    assert.equal(scanResultData(result).status, 'REVIEW', version);
  }
});

test('remaster mismatch is symmetric and different remaster years conflict', () => {
  const originalToRemaster = matchTrack(spotify(), [candidate({ title: 'Blinding Lights (2011 Remastered)' })]);
  const remasterToOriginal = matchTrack(
    spotify({ title: 'Blinding Lights (2011 Remastered)' }),
    [candidate({ title: 'Blinding Lights' })],
  );
  const differentYears = matchTrack(
    spotify({ title: 'Blinding Lights (2011 Remastered)' }),
    [candidate({ title: 'Blinding Lights (2020 Remastered)' })],
  );
  for (const result of [originalToRemaster, remasterToOriginal, differentYears]) {
    assert.equal(result.matched, false);
    assert.ok(result.selectedCandidate.reasons.includes('version mismatch'));
  }
});

test('the same remaster signature can qualify for exact evidence', () => {
  const result = matchTrack(
    spotify({ title: 'Blinding Lights (2011 Remastered)' }),
    [candidate({ title: 'Blinding Lights (2011 Remastered)' })],
  );
  assert.equal(result.matched, true);
  assert.equal(result.matchTier, 'EXACT');
});

test('version words use boundaries rather than substrings', () => {
  const alive = matchTrack(
    spotify({ title: 'Alive', artists: ['Artist'] }),
    [candidate({ title: 'Alive (Live)', artists: ['Artist'] })],
  );
  assert.equal(alive.matched, false);
  assert.ok(alive.selectedCandidate.reasons.includes('version mismatch'));

  for (const title of ['Discover', 'Credit']) {
    const unchanged = matchTrack(
      spotify({ title, artists: ['Artist'] }),
      [candidate({ title, artists: ['Artist'] })],
    );
    assert.equal(unchanged.matched, true, title);
    assert.equal(unchanged.matchTier, 'EXACT', title);
    assert.ok(!unchanged.selectedCandidate.reasons.includes('version mismatch'), title);
  }
});

test('artist sets are order-independent and normalize ampersands', () => {
  const result = matchTrack(
    spotify({ title: 'Collaboration', artists: ['First Artist', 'bees & honey'] }),
    [candidate({ title: 'Collaboration', artists: ['bees and honey', 'First Artist', 'First Artist'] })],
  );
  assert.equal(result.matched, true);
  assert.equal(result.matchTier, 'EXACT');
  assert.equal(result.selectedCandidate.scoreBreakdown.artist, 1);
});

test('featured artists in titles reconcile with artist arrays', () => {
  for (const marker of ['feat.', 'ft.', 'featuring']) {
    const result = matchTrack(
      spotify({ title: `Signal ${marker} Guest`, artists: ['The Waves', 'Guest'] }),
      [candidate({ title: 'Signal', artists: ['Guest', 'The Waves'] })],
    );
    assert.equal(result.matched, true, marker);
    assert.equal(result.matchTier, 'EXACT', marker);
    assert.equal(result.selectedCandidate.scoreBreakdown.title, 1, marker);
    assert.equal(result.selectedCandidate.scoreBreakdown.artist, 1, marker);
  }

  const combinedCredit = matchTrack(
    spotify({ title: 'Signal', artists: ['The Waves feat. Guest'] }),
    [candidate({ title: 'Signal', artists: ['The Waves', 'Guest'] })],
  );
  assert.equal(combinedCredit.matchTier, 'EXACT');
});

test('a missing featured artist is not an exact artist-set match', () => {
  const result = matchTrack(
    spotify({ title: 'Signal feat. Guest', artists: ['The Waves', 'Guest'] }),
    [candidate({ title: 'Signal', artists: ['The Waves'] })],
  );
  assert.equal(result.matched, false);
  assert.equal(result.matchTier, 'WEIGHTED');
  assert.ok(result.selectedCandidate.reasons.includes('artist mismatch'));
});

test('album mismatch alone does not downgrade exact evidence', () => {
  const result = matchTrack(spotify(), [candidate({ album: 'Completely Different Album' })]);
  assert.equal(result.matched, true);
  assert.equal(result.confidence, 'HIGH');
  assert.equal(result.matchTier, 'EXACT');
});

test('missing duration and generic UGC results cannot enter the exact tier', () => {
  const missingDuration = matchTrack(spotify(), [candidate({ durationMs: null })]);
  const ugc = matchTrack(spotify(), [candidate({ resultType: 'video', videoType: 'MUSIC_VIDEO_TYPE_UGC' })]);
  assert.equal(missingDuration.matchTier, 'WEIGHTED');
  assert.equal(ugc.matchTier, 'WEIGHTED');
});
