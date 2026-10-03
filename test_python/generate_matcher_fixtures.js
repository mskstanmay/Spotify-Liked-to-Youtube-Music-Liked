// Regenerates the expected values in fixtures/matcher_cases.json from the
// authoritative JavaScript matcher. It intentionally writes only to stdout.
const { matchTrack, normalizeString } = require('../src/matching/trackMatcher');

const cases = [
  {
    name: 'exact_song',
    spotify: { title: 'Midnight City', artists: ['M83'], album: 'Hurry Up, We\'re Dreaming', durationMs: 244000 },
    candidates: [
      { videoId: 'exact', title: 'Midnight City', artists: ['M83'], album: 'Hurry Up, We\'re Dreaming', durationMs: 244000, resultType: 'song', videoType: 'MUSIC_VIDEO_TYPE_ATV' },
      { videoId: 'cover', title: 'Midnight City (Cover)', artists: ['Other Artist'], album: '', durationMs: 250000, resultType: 'video', videoType: 'MUSIC_VIDEO_TYPE_UGC' },
    ],
  },
  {
    name: 'safe_medium_duration',
    spotify: { title: 'Signal', artists: ['The Waves'], album: '', durationMs: 180000 },
    candidates: [
      { videoId: 'medium', title: 'Signal', artists: ['The Waves'], album: '', durationMs: 230000, resultType: 'video', videoType: 'MUSIC_VIDEO_TYPE_UGC' },
    ],
  },
  {
    name: 'close_second',
    spotify: { title: 'Home', artists: ['Daughter'], album: 'The Wild Youth', durationMs: 250000 },
    candidates: [
      { videoId: 'one', title: 'Home', artists: ['Daughter'], album: 'The Wild Youth', durationMs: 250000, resultType: 'song' },
      { videoId: 'two', title: 'Home', artists: ['Daughter'], album: 'The Wild Youth', durationMs: 254000, resultType: 'song' },
    ],
  },
  {
    name: 'version_mismatch',
    spotify: { title: 'Alive', artists: ['Artist'], album: 'Record', durationMs: 200000 },
    candidates: [
      { videoId: 'live', title: 'Alive (Live)', artists: ['Artist'], album: 'Record', durationMs: 201000, resultType: 'song' },
    ],
  },
  {
    name: 'artist_mismatch',
    spotify: { title: 'Fire', artists: ['First Artist'], album: 'Record', durationMs: 200000 },
    candidates: [
      { videoId: 'wrong', title: 'Fire', artists: ['Second Artist'], album: 'Record', durationMs: 200000, resultType: 'song' },
    ],
  },
  {
    name: 'no_candidates',
    spotify: { title: 'Missing', artists: ['Nobody'], album: '', durationMs: 100000 },
    candidates: [],
  },
];

function projected(result) {
  return {
    matched: result.matched,
    closeSecond: result.closeSecond,
    videoId: result.videoId ?? null,
    title: result.title ?? null,
    artists: result.artists ?? null,
    score: result.score ?? null,
    confidence: result.confidence,
    reason: result.reason,
    candidates: result.candidates.map((candidate) => ({
      videoId: candidate.videoId,
      score: candidate.score,
      scoreBreakdown: candidate.scoreBreakdown,
      reasons: candidate.reasons,
    })),
  };
}

const output = {
  normalization: [
    ['Beyonce\u0301 & JAY-Z feat. Guest (Official Music Video)', normalizeString('Beyonce\u0301 & JAY-Z feat. Guest (Official Music Video)')],
    ['Song [Live] {Visualizer}', normalizeString('Song [Live] {Visualizer}')],
  ],
  cases: cases.map((fixture) => ({ ...fixture, expected: projected(matchTrack(fixture.spotify, fixture.candidates, { threshold: 0.85 })) })),
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
