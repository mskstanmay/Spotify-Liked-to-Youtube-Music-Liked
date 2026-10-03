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
      { videoId: 'one', title: 'Home', artists: ['Daughter'], album: 'The Wild Youth', durationMs: 245000, resultType: 'song' },
      { videoId: 'two', title: 'Home', artists: ['Daughter'], album: 'The Wild Youth', durationMs: 255000, resultType: 'song' },
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
  {
    name: 'take_my_mind_exact_identity',
    spotify: { title: 'Take My Mind', artists: ['WizTheMc', 'bees & honey'], album: 'YEBO', durationMs: 171199 },
    candidates: [
      { videoId: 'UAepuqX-StE', title: 'Take My Mind', artists: ['WizTheMc', 'bees & honey'], album: null, durationMs: 172000, resultType: 'video', videoType: 'MUSIC_VIDEO_TYPE_OMV' },
      { videoId: 'ukxikZCIRBU', title: 'Take My Mind', artists: ['WizTheMc', 'bees & honey'], album: 'Take My Mind', durationMs: 172000, resultType: 'song', videoType: 'MUSIC_VIDEO_TYPE_ATV' },
    ],
  },
  {
    name: 'exact_duration_boundary',
    spotify: { title: 'Boundary', artists: ['Artist'], album: 'Source', durationMs: 171000 },
    candidates: [{ videoId: 'boundary', title: 'Boundary', artists: ['Artist'], album: 'Other', durationMs: 174000, resultType: 'song' }],
  },
  {
    name: 'weighted_after_duration_boundary',
    spotify: { title: 'Boundary', artists: ['Artist'], album: 'Source', durationMs: 171000 },
    candidates: [{ videoId: 'boundary', title: 'Boundary', artists: ['Artist'], album: 'Other', durationMs: 174001, resultType: 'song' }],
  },
  {
    name: 'featured_artist_formatting',
    spotify: { title: 'Signal feat. Guest', artists: ['The Waves', 'Guest'], album: 'Source', durationMs: 180000 },
    candidates: [{ videoId: 'feature', title: 'Signal', artists: ['Guest', 'The Waves'], album: 'Other', durationMs: 181000, resultType: 'song' }],
  },
  {
    name: 'same_remaster',
    spotify: { title: 'Song (2011 Remastered)', artists: ['Artist'], album: 'Source', durationMs: 180000 },
    candidates: [{ videoId: 'remaster', title: 'Song (2011 Remastered)', artists: ['Artist'], album: 'Other', durationMs: 181000, resultType: 'song' }],
  },
  {
    name: 'generic_ugc_weighted',
    spotify: { title: 'Song', artists: ['Artist'], album: 'Source', durationMs: 180000 },
    candidates: [{ videoId: 'ugc', title: 'Song', artists: ['Artist'], album: 'Source', durationMs: 181000, resultType: 'video', videoType: 'MUSIC_VIDEO_TYPE_UGC' }],
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
    matchTier: result.matchTier,
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
