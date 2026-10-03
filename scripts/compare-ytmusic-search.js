const fs = require('node:fs/promises');
const path = require('node:path');
const legacyYtmusic = require('../src/ytmusic/client');
const { createNativeSearch } = require('../src/ytmusic/nativeSearch');
const { matchTrack } = require('../src/matching/trackMatcher');
const { scanResultData } = require('../src/worker/migrationWorker');

function argument(name, fallback = null) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function normalizeTrack(track) {
  return {
    title: track.title || track.spotifyTitle || '',
    artists: track.artists || track.spotifyArtists || [],
    album: track.album || track.spotifyAlbum || '',
    durationMs: track.durationMs || track.spotifyDurationMs || 0,
  };
}

function outcome(track, candidates, threshold, autoReviewMinScore) {
  const match = matchTrack(track, candidates, { threshold });
  const state = scanResultData(match, autoReviewMinScore);
  return {
    candidateVideoIds: candidates.map((candidate) => candidate.videoId),
    selectedVideoId: state.matchedYoutubeVideoId || match.selectedCandidate?.videoId || null,
    status: state.status,
    needsReview: state.needsReview,
    confidence: match.confidence,
    score: match.score ?? null,
    closeSecond: match.closeSecond,
  };
}

function sameOutcome(left, right) {
  return left.selectedVideoId === right.selectedVideoId
    && left.status === right.status
    && left.needsReview === right.needsReview
    && left.confidence === right.confidence
    && left.score === right.score
    && left.closeSecond === right.closeSecond;
}

async function main() {
  const inputPath = process.argv.slice(2).find((item) => !item.startsWith('--'));
  if (!inputPath) {
    throw new Error('Usage: node scripts/compare-ytmusic-search.js <tracks.json> [--limit=10] [--threshold=0.85] [--auto-review-min-score=0.72]');
  }
  const limit = Number(argument('limit', process.env.YTMUSIC_SEARCH_LIMIT || 10));
  const threshold = Number(argument('threshold', process.env.MATCH_CONFIDENCE_THRESHOLD || 0.85));
  const autoReviewMinScore = Number(argument('auto-review-min-score', process.env.AUTO_REVIEW_MIN_SCORE || 0.72));
  const timeoutMs = Number(process.env.YTMUSIC_SEARCH_TIMEOUT_MS || 30_000);
  const payload = JSON.parse(await fs.readFile(path.resolve(inputPath), 'utf8'));
  const tracks = Array.isArray(payload) ? payload : (payload.tracks || []);
  const nativeSearch = createNativeSearch({ limit, timeoutMs });
  const comparisons = [];

  for (const source of tracks) {
    const track = normalizeTrack(source);
    const query = `${track.title} ${track.artists.join(' ')}`.trim();
    const [pythonCandidates, nativeCandidates] = await Promise.all([
      legacyYtmusic.runPython(['search', '--query', query, '--limit', String(limit)])
        .then((result) => result.results || []),
      nativeSearch(track),
    ]);
    const python = outcome(track, pythonCandidates, threshold, autoReviewMinScore);
    const native = outcome(track, nativeCandidates, threshold, autoReviewMinScore);
    comparisons.push({
      track: { title: track.title, artists: track.artists },
      matches: sameOutcome(python, native),
      python,
      native,
    });
  }

  const mismatches = comparisons.filter((comparison) => !comparison.matches).length;
  process.stdout.write(`${JSON.stringify({ compared: comparisons.length, mismatches, comparisons }, null, 2)}\n`);
  if (mismatches) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
