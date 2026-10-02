function migrationJson(migration) {
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
    processedTracks: migration.processedTracks,
    confidentCount: migration.confidentCount,
    likedCount: migration.likedCount,
    alreadyLikedCount: migration.alreadyLikedCount,
    reviewCount: migration.reviewCount,
    notFoundCount: migration.notFoundCount,
    failedCount: migration.failedCount,
    skippedCount: migration.skippedCount,
    currentTrack: migration.currentTrackTitle ? { title: migration.currentTrackTitle, artist: migration.currentTrackArtist } : null,
    error: migration.lastErrorMessage ? { code: migration.lastErrorCode, message: migration.lastErrorMessage } : null,
    startedAt: migration.startedAt,
    completedAt: migration.completedAt,
    createdAt: migration.createdAt,
    updatedAt: migration.updatedAt,
  };
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
      externalUrl: `https://music.youtube.com/watch?v=${encodeURIComponent(track.matchedYoutubeVideoId)}`,
    } : null,
    reason: track.reason,
    status: track.status.toLowerCase(),
    error: track.errorMessage ? { code: track.errorCode, message: track.errorMessage } : null,
  };
  if (includeCandidates) value.candidates = (track.candidates || []).map(candidateJson);
  return value;
}

module.exports = { migrationJson, trackJson, candidateJson };
