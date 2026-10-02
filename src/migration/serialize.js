function migrationJson(migration, derivedCounts = {}) {
  const count = (name) => derivedCounts[name] ?? migration[name] ?? 0;
  const likedCount = derivedCounts.likedCount ?? migration.likedCount ?? 0;
  const addedReviewCount = derivedCounts.addedReviewCount ?? 0;
  const needsReviewCount = derivedCounts.needsReviewCount ?? 0;
  const failedCount = derivedCounts.failedCount ?? migration.failedCount ?? 0;
  const notFoundCount = derivedCounts.notFoundCount ?? migration.notFoundCount ?? 0;
  return {
    id: migration.id,
    source: migration.source,
    destination: migration.destination,
    status: migration.status.toLowerCase(),
    phase: migration.phase?.toLowerCase(),
    totalTracks: migration.totalTracks,
    sourceTotalTracks: migration.sourceTotalTracks,
    trackLimit: migration.trackLimit,
    limited: Boolean(migration.trackLimit && migration.sourceTotalTracks > migration.trackLimit),
    processedTracks: count('processedTracks'),
    confidentCount: count('confidentCount'),
    likedCount,
    addedCount: Math.max(0, likedCount - addedReviewCount),
    addedReviewCount,
    needsReviewCount,
    alreadyLikedCount: count('alreadyLikedCount'),
    reviewCount: count('reviewCount'),
    notFoundCount,
    failedCount,
    unsuccessfulCount: failedCount + notFoundCount,
    skippedCount: count('skippedCount'),
    currentTrack: migration.currentTrackTitle ? { title: migration.currentTrackTitle, artist: migration.currentTrackArtist } : null,
    error: migration.lastErrorMessage ? { code: migration.lastErrorCode, message: migration.lastErrorMessage } : null,
    startedAt: migration.startedAt,
    completedAt: migration.completedAt,
    createdAt: migration.createdAt,
    updatedAt: migration.updatedAt,
  };
}

function resultCategory(track) {
  switch (track.status) {
    case 'LIKED': return track.needsReview ? 'added_review' : 'added';
    case 'ALREADY_LIKED': return 'already_existed';
    case 'FAILED': return 'failed';
    case 'NOT_FOUND': return 'not_found';
    case 'REVIEW': return 'manual_review';
    case 'SKIPPED': return 'skipped';
    default: return 'pending';
  }
}

function candidateJson(candidate) {
  return {
    id: candidate.id,
    videoId: candidate.videoId,
    title: candidate.title,
    artists: candidate.artists,
    album: candidate.album,
    durationMs: candidate.durationMs,
    resultType: candidate.resultType,
    score: candidate.score,
    reasons: candidate.reasons,
    externalUrl: `https://music.youtube.com/watch?v=${encodeURIComponent(candidate.videoId)}`,
  };
}

function trackJson(track, includeCandidates = false) {
  const value = {
    id: track.id,
    position: track.position,
    spotify: {
      id: track.spotifyTrackId,
      title: track.spotifyTitle,
      artists: track.spotifyArtists,
      album: track.spotifyAlbum,
      durationMs: track.spotifyDurationMs,
      externalUrl: track.spotifyUrl,
    },
    match: track.matchedYoutubeVideoId ? {
      videoId: track.matchedYoutubeVideoId,
      title: track.matchedYoutubeTitle,
      artists: track.matchedYoutubeArtists,
      confidence: track.confidence,
      score: track.score,
      reason: track.reason,
      externalUrl: `https://music.youtube.com/watch?v=${encodeURIComponent(track.matchedYoutubeVideoId)}`,
    } : null,
    reason: track.reason,
    status: track.status.toLowerCase(),
    needsReview: Boolean(track.needsReview),
    resultCategory: resultCategory(track),
    error: track.errorMessage ? { code: track.errorCode, message: track.errorMessage } : null,
  };
  if (includeCandidates) value.candidates = (track.candidates || []).map(candidateJson);
  return value;
}

module.exports = { migrationJson, trackJson, candidateJson, resultCategory };
