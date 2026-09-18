const VERSION_TERMS = {
  live: ['live', 'concert', 'session'],
  remix: ['remix', 'edit', 'mix'],
  cover: ['cover', 'tribute', 'karaoke'],
  acoustic: ['acoustic', 'unplugged'],
  sped: ['sped up', 'speed up', 'slowed', 'nightcore', 'lofi'],
  instrumental: ['instrumental'],
  remaster: ['remaster', 'remastered'],
};

function normalizeString(value = '') {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\b(feat|ft|featuring)\.?\b/g, ' ')
    .replace(/\bofficial\s+(audio|video|music video|lyric video)\b/g, ' ')
    .replace(/\b(audio|lyrics?|visualizer)\b/g, ' ')
    .replace(/[()[\]{}]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripVersionNoise(value = '') {
  let normalized = normalizeString(value);
  for (const terms of Object.values(VERSION_TERMS)) {
    for (const term of terms) {
      normalized = normalized.replace(new RegExp(`\\b${term.replace(/\s+/g, '\\s+')}\\b`, 'g'), ' ');
    }
  }
  return normalized.replace(/\s+/g, ' ').trim();
}

function tokens(value) {
  return new Set(normalizeString(value).split(' ').filter(Boolean));
}

function jaccard(a, b) {
  const left = tokens(a);
  const right = tokens(b);
  if (!left.size && !right.size) return 1;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / new Set([...left, ...right]).size;
}

function titleSimilarity(a, b) {
  const cleanA = stripVersionNoise(a);
  const cleanB = stripVersionNoise(b);
  if (cleanA && cleanA === cleanB) return 1;
  if (cleanA && cleanB && (cleanA.includes(cleanB) || cleanB.includes(cleanA))) return 0.9;
  return jaccard(cleanA, cleanB);
}

function artistSimilarity(spotifyArtists = [], ytmArtists = []) {
  const spotify = spotifyArtists.map(normalizeString).filter(Boolean);
  const ytm = ytmArtists.map(normalizeString).filter(Boolean);
  if (!spotify.length || !ytm.length) return 0;

  let hits = 0;
  for (const artist of spotify) {
    if (ytm.some((candidate) => candidate === artist || candidate.includes(artist) || artist.includes(candidate))) {
      hits += 1;
    }
  }

  const primaryBonus = ytm.some((candidate) => candidate === spotify[0]) ? 0.1 : 0;
  return Math.min(1, (hits / spotify.length) + primaryBonus);
}

function albumSimilarity(spotifyAlbum = '', ytmAlbum = '') {
  if (!spotifyAlbum || !ytmAlbum) return 0.5;
  const a = normalizeString(spotifyAlbum);
  const b = normalizeString(ytmAlbum);
  if (a === b) return 1;
  return jaccard(a, b);
}

function durationSimilarity(spotifyMs = 0, ytmMs = 0) {
  if (!spotifyMs || !ytmMs) return 0.5;
  const delta = Math.abs(spotifyMs - ytmMs);
  if (delta <= 3000) return 1;
  if (delta <= 8000) return 0.85;
  if (delta <= 15000) return 0.65;
  if (delta <= 30000) return 0.35;
  return 0;
}

function detectVersionFlags(value = '') {
  const normalized = normalizeString(value);
  const flags = {};
  for (const [flag, terms] of Object.entries(VERSION_TERMS)) {
    flags[flag] = terms.some((term) => normalized.includes(normalizeString(term)));
  }
  return flags;
}

function versionPenalty(spotifyTitle, ytmTitle) {
  const spotify = detectVersionFlags(spotifyTitle);
  const ytm = detectVersionFlags(ytmTitle);
  let penalty = 0;
  for (const flag of ['live', 'remix', 'cover', 'acoustic', 'sped', 'instrumental']) {
    if (spotify[flag] !== ytm[flag]) penalty += flag === 'remix' ? 0.18 : 0.15;
  }
  if (!spotify.remaster && ytm.remaster) penalty += 0.04;
  return Math.min(0.5, penalty);
}

function resultTypeScore(candidate) {
  const resultType = normalizeString(candidate.resultType || '');
  const videoType = normalizeString(candidate.videoType || '');
  if (resultType === 'song' || videoType.includes('music video type atv')) return 1;
  if (resultType === 'video') return 0.72;
  return 0.45;
}

function scoreCandidate(spotifyTrack, candidate) {
  const title = titleSimilarity(spotifyTrack.title, candidate.title);
  const artist = artistSimilarity(spotifyTrack.artists, candidate.artists);
  const duration = durationSimilarity(spotifyTrack.durationMs, candidate.durationMs);
  const album = albumSimilarity(spotifyTrack.album, candidate.album);
  const type = resultTypeScore(candidate);
  const penalty = versionPenalty(spotifyTrack.title, candidate.title);

  const score = (title * 0.36) + (artist * 0.31) + (duration * 0.18) + (album * 0.08) + (type * 0.07) - penalty;
  const reasons = [];
  if (title < 0.75) reasons.push('title mismatch');
  if (artist < 0.75) reasons.push('artist mismatch');
  if (duration < 0.65) reasons.push('duration mismatch');
  if (penalty > 0) reasons.push('version mismatch');
  if (type < 0.75) reasons.push('non-song result');

  return {
    ...candidate,
    score: Math.max(0, Math.min(1, Number(score.toFixed(4)))),
    scoreBreakdown: { title, artist, duration, album, type, penalty },
    reasons,
  };
}

function confidenceFor(score, reasons) {
  if (score >= 0.9 && reasons.length === 0) return 'HIGH';
  if (score >= 0.85 && !reasons.includes('artist mismatch') && !reasons.includes('version mismatch')) return 'HIGH';
  if (score >= 0.72 && !reasons.includes('artist mismatch')) return 'MEDIUM';
  return 'LOW';
}

function matchTrack(spotifyTrack, candidates, options = {}) {
  const threshold = options.threshold ?? 0.85;
  const scored = (candidates || [])
    .filter((candidate) => candidate?.videoId)
    .map((candidate) => scoreCandidate(spotifyTrack, candidate))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) {
    return {
      matched: false,
      confidence: 'LOW',
      reason: 'No YouTube Music candidates returned.',
      candidates: [],
    };
  }

  const second = scored[1];
  const closeSecond = second && best.score - second.score < 0.04;
  const confidence = closeSecond ? 'MEDIUM' : confidenceFor(best.score, best.reasons);
  const matched = best.score >= threshold && confidence === 'HIGH' && !closeSecond;

  return {
    matched,
    videoId: matched ? best.videoId : null,
    title: best.title,
    artists: best.artists || [],
    score: best.score,
    confidence,
    selectedCandidate: best,
    candidates: scored,
    reason: matched ? '' : uncertaintyReason(best, closeSecond, threshold),
  };
}

function uncertaintyReason(best, closeSecond, threshold) {
  if (closeSecond) return 'Top candidates are too close to choose safely.';
  if (best.score < threshold) return `Best score ${best.score} is below threshold ${threshold}.`;
  if (best.reasons?.length) return best.reasons.join(', ');
  return 'Match is not high confidence.';
}

module.exports = {
  normalizeString,
  scoreCandidate,
  matchTrack,
};
