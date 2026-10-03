const VERSION_DEFINITIONS = {
  live: { patterns: ['\\blive\\b', '\\bconcert\\b', '\\bsession\\b'], penalty: 0.15 },
  acoustic: { patterns: ['\\bacoustic\\b'], penalty: 0.15 },
  unplugged: { patterns: ['\\bunplugged\\b'], penalty: 0.15 },
  remix: { patterns: ['\\bremix(?:ed)?\\b'], penalty: 0.18 },
  rework: { patterns: ['\\brework(?:ed)?\\b'], penalty: 0.18 },
  radioEdit: { patterns: ['\\bradio\\s+(?:edit|version)\\b'], penalty: 0.15 },
  extended: { patterns: ['\\bextended(?:\\s+(?:mix|edit|version))?\\b'], penalty: 0.15 },
  instrumental: { patterns: ['\\binstrumental\\b'], penalty: 0.15 },
  karaoke: { patterns: ['\\bkaraoke\\b'], penalty: 0.15 },
  spedUp: { patterns: ['\\b(?:sped|speed)\\s+up\\b', '\\bnightcore\\b'], penalty: 0.15 },
  slowed: { patterns: ['\\bslowed(?:\\s+down)?\\b'], penalty: 0.15 },
  remastered: {
    patterns: [
      '\\b(?:19|20)\\d{2}\\s+remaster(?:ed)?\\b',
      '\\bremaster(?:ed)?(?:\\s+(?:19|20)\\d{2})?\\b',
    ],
    penalty: 0.04,
  },
  cover: { patterns: ['\\bcover\\b'], penalty: 0.15 },
  tribute: { patterns: ['\\btribute\\b'], penalty: 0.15 },
};

const VERSION_FLAGS = Object.keys(VERSION_DEFINITIONS);

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

function featureCredits(value = '') {
  let base = String(value);
  const featured = [];
  base = base.replace(/[([{]\s*(?:feat(?:uring)?|ft)\.?\s+([^\])}]+)[\])}]/gi, (_match, credit) => {
    if (credit?.trim()) featured.push(credit.trim());
    return ' ';
  });
  base = base.replace(/\s+(?:feat(?:uring)?|ft)\.?\s+(.+)$/i, (_match, credit) => {
    if (credit?.trim()) featured.push(credit.trim());
    return ' ';
  });
  return { base, featured };
}

function canonicalArtistSet(artists = [], title = '') {
  const values = [];
  for (const artist of artists || []) {
    const parsed = featureCredits(artist);
    values.push(parsed.base, ...parsed.featured);
  }
  values.push(...featureCredits(title).featured);
  return new Set(values.map(normalizeString).filter(Boolean));
}

function setsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function exactArtistSets(spotifyTrack, candidate) {
  const spotify = canonicalArtistSet(spotifyTrack.artists, spotifyTrack.title);
  const ytm = canonicalArtistSet(candidate.artists, candidate.title);
  return spotify.size > 0 && ytm.size > 0 && setsEqual(spotify, ytm);
}

function detectVersionSignature(value = '') {
  const normalized = normalizeString(value);
  const signature = {};
  for (const [flag, definition] of Object.entries(VERSION_DEFINITIONS)) {
    signature[flag] = definition.patterns.some((pattern) => new RegExp(pattern).test(normalized));
  }
  const after = normalized.match(/\bremaster(?:ed)?\s+((?:19|20)\d{2})\b/);
  const before = normalized.match(/\b((?:19|20)\d{2})\s+remaster(?:ed)?\b/);
  signature.remasterYear = after?.[1] || before?.[1] || null;
  return signature;
}

function versionSignaturesDiffer(leftTitle, rightTitle) {
  const left = detectVersionSignature(leftTitle);
  const right = detectVersionSignature(rightTitle);
  if (VERSION_FLAGS.some((flag) => left[flag] !== right[flag])) return true;
  return Boolean(left.remastered && right.remastered
    && left.remasterYear && right.remasterYear
    && left.remasterYear !== right.remasterYear);
}

function stripVersionNoise(value = '') {
  let normalized = normalizeString(featureCredits(value).base);
  for (const definition of Object.values(VERSION_DEFINITIONS)) {
    for (const pattern of definition.patterns) {
      normalized = normalized.replace(new RegExp(pattern, 'g'), ' ');
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

function artistSimilarity(spotifyArtists = [], ytmArtists = [], spotifyTitle = '', ytmTitle = '') {
  const spotify = canonicalArtistSet(spotifyArtists, spotifyTitle);
  const ytm = canonicalArtistSet(ytmArtists, ytmTitle);
  if (!spotify.size || !ytm.size) return 0;
  let intersection = 0;
  for (const artist of spotify) {
    if (ytm.has(artist)) intersection += 1;
  }
  return (2 * intersection) / (spotify.size + ytm.size);
}

function albumSimilarity(spotifyAlbum = '', ytmAlbum = '') {
  if (!spotifyAlbum || !ytmAlbum) return 0.5;
  const a = normalizeString(spotifyAlbum);
  const b = normalizeString(ytmAlbum);
  if (a === b) return 1;
  return jaccard(a, b);
}

function exactAlbumMatch(spotifyAlbum = '', ytmAlbum = '') {
  if (!spotifyAlbum || !ytmAlbum) return false;
  return normalizeString(spotifyAlbum) === normalizeString(ytmAlbum);
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

function durationDelta(spotifyMs, ytmMs) {
  const left = Number(spotifyMs);
  const right = Number(ytmMs);
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) return null;
  return Math.abs(left - right);
}

function versionPenalty(spotifyTitle, ytmTitle) {
  const spotify = detectVersionSignature(spotifyTitle);
  const ytm = detectVersionSignature(ytmTitle);
  let penalty = 0;
  for (const flag of VERSION_FLAGS) {
    if (spotify[flag] !== ytm[flag]) penalty += VERSION_DEFINITIONS[flag].penalty;
  }
  if (spotify.remastered && ytm.remastered
    && spotify.remasterYear && ytm.remasterYear
    && spotify.remasterYear !== ytm.remasterYear) {
    penalty += VERSION_DEFINITIONS.remastered.penalty;
  }
  return Math.min(0.5, penalty);
}

function resultTypeScore(candidate) {
  const resultType = normalizeString(candidate.resultType || '');
  const videoType = normalizeString(candidate.videoType || '');
  if (resultType === 'song' || videoType.includes('music video type atv')) return 1;
  if (resultType === 'video') return 0.72;
  return 0.45;
}

function trustedResultRank(candidate) {
  const resultType = normalizeString(candidate.resultType || '');
  const videoType = normalizeString(candidate.videoType || '');
  if (resultType === 'song' || videoType.includes('music video type atv')) return 2;
  if (videoType.includes('music video type omv')) return 1;
  return 0;
}

function isExactEvidenceCandidate(spotifyTrack, candidate) {
  const spotifyTitle = stripVersionNoise(spotifyTrack.title);
  const ytmTitle = stripVersionNoise(candidate.title);
  const delta = durationDelta(spotifyTrack.durationMs, candidate.durationMs);
  return Boolean(
    spotifyTitle
    && spotifyTitle === ytmTitle
    && exactArtistSets(spotifyTrack, candidate)
    && delta !== null
    && delta <= 3000
    && !versionSignaturesDiffer(spotifyTrack.title, candidate.title)
    && trustedResultRank(candidate) > 0
  );
}

function sameIdentity(left, right) {
  const leftTitle = stripVersionNoise(left.title);
  const rightTitle = stripVersionNoise(right.title);
  const delta = durationDelta(left.durationMs, right.durationMs);
  return Boolean(
    leftTitle
    && leftTitle === rightTitle
    && exactArtistSets(left, right)
    && !versionSignaturesDiffer(left.title, right.title)
    && delta !== null
    && delta <= 3000
  );
}

function scoreCandidate(spotifyTrack, candidate) {
  const title = titleSimilarity(spotifyTrack.title, candidate.title);
  const artist = artistSimilarity(
    spotifyTrack.artists,
    candidate.artists,
    spotifyTrack.title,
    candidate.title,
  );
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

function exactTierComparator(spotifyTrack) {
  return (left, right) => {
    if (left.exact !== right.exact) return left.exact ? -1 : 1;
    if (!left.exact) return (right.scored.score - left.scored.score) || (left.index - right.index);
    const typeDifference = trustedResultRank(right.scored) - trustedResultRank(left.scored);
    if (typeDifference) return typeDifference;
    const durationDifference = durationDelta(spotifyTrack.durationMs, left.scored.durationMs)
      - durationDelta(spotifyTrack.durationMs, right.scored.durationMs);
    if (durationDifference) return durationDifference;
    const leftAlbum = exactAlbumMatch(spotifyTrack.album, left.scored.album);
    const rightAlbum = exactAlbumMatch(spotifyTrack.album, right.scored.album);
    if (leftAlbum !== rightAlbum) return leftAlbum ? -1 : 1;
    return left.index - right.index;
  };
}

function matchTrack(spotifyTrack, candidates, options = {}) {
  const threshold = options.threshold ?? 0.85;
  const ranked = (candidates || [])
    .filter((candidate) => candidate?.videoId)
    .map((candidate, index) => ({
      scored: scoreCandidate(spotifyTrack, candidate),
      exact: isExactEvidenceCandidate(spotifyTrack, candidate),
      index,
    }))
    .sort(exactTierComparator(spotifyTrack));
  const scored = ranked.map((candidate) => candidate.scored);

  const bestEntry = ranked[0];
  if (!bestEntry) {
    return {
      matched: false,
      closeSecond: false,
      confidence: 'LOW',
      matchTier: 'WEIGHTED',
      reason: 'No YouTube Music candidates returned.',
      candidates: [],
    };
  }

  const best = bestEntry.scored;
  let competitor;
  if (bestEntry.exact) {
    competitor = ranked
      .filter((entry) => !sameIdentity(best, entry.scored))
      .reduce((highest, entry) => (!highest || entry.scored.score > highest.score ? entry.scored : highest), null);
  } else {
    competitor = ranked[1]?.scored;
  }
  const closeSecond = Boolean(competitor && best.score - competitor.score < 0.04);
  const confidence = closeSecond ? 'MEDIUM' : (bestEntry.exact ? 'HIGH' : confidenceFor(best.score, best.reasons));
  const matched = best.score >= threshold && confidence === 'HIGH' && !closeSecond;

  return {
    matched,
    closeSecond,
    videoId: matched ? best.videoId : null,
    title: best.title,
    artists: best.artists || [],
    score: best.score,
    confidence,
    matchTier: bestEntry.exact ? 'EXACT' : 'WEIGHTED',
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
