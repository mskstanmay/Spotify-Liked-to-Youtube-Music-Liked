const LIKE_TERMINAL_TRACK_STATUSES = ['LIKED', 'ALREADY_LIKED', 'REVIEW', 'NOT_FOUND', 'FAILED', 'SKIPPED'];

function counterData(groups, matchedCount, phase) {
  const counts = {};
  let addedReviewCount = 0;
  let needsReviewCount = 0;
  for (const group of groups) {
    const count = group._count._all;
    counts[group.status] = (counts[group.status] || 0) + count;
    if (group.needsReview) {
      needsReviewCount += count;
      if (group.status === 'LIKED') addedReviewCount += count;
    }
  }
  const allTracks = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const processedTracks = phase === 'SCANNING'
    ? allTracks - (counts.PENDING || 0) - (counts.SCANNING || 0)
    : LIKE_TERMINAL_TRACK_STATUSES.reduce((sum, status) => sum + (counts[status] || 0), 0);
  return {
    processedTracks,
    confidentCount: matchedCount,
    likedCount: counts.LIKED || 0,
    alreadyLikedCount: counts.ALREADY_LIKED || 0,
    reviewCount: counts.REVIEW || 0,
    notFoundCount: counts.NOT_FOUND || 0,
    failedCount: counts.FAILED || 0,
    skippedCount: counts.SKIPPED || 0,
    addedReviewCount,
    needsReviewCount,
  };
}

function persistedCounterData(counters) {
  const { addedReviewCount, needsReviewCount, ...persisted } = counters;
  return persisted;
}

async function countMigrationTracks(prisma, migrationId, phase) {
  const [groups, matchedCount] = await Promise.all([
    prisma.migrationTrack.groupBy({ by: ['status', 'needsReview'], where: { migrationId }, _count: { _all: true } }),
    prisma.migrationTrack.count({ where: { migrationId, matchedYoutubeVideoId: { not: null } } }),
  ]);
  return counterData(groups, matchedCount, phase);
}

async function refreshCounts(prisma, migrationId, phase) {
  let currentPhase = phase;
  if (!currentPhase) {
    const migration = await prisma.migration.findUnique({ where: { id: migrationId }, select: { phase: true } });
    currentPhase = migration?.phase || 'LIKING';
  }
  const data = await countMigrationTracks(prisma, migrationId, currentPhase);
  return prisma.migration.update({ where: { id: migrationId }, data: persistedCounterData(data) });
}

module.exports = { LIKE_TERMINAL_TRACK_STATUSES, counterData, persistedCounterData, countMigrationTracks, refreshCounts };
