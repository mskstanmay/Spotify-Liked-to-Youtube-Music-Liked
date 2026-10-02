async function videoLikeRow(prisma, userId, videoId) {
  return prisma.youTubeVideoLike.upsert({
    where: { userId_videoId: { userId, videoId } },
    create: { userId, videoId },
    update: {},
  });
}

async function tryClaimVideoLike(prisma, { userId, videoId, ownerId, lockedUntil }) {
  const row = await videoLikeRow(prisma, userId, videoId);
  if (row.status === 'LIKED') return { state: 'LIKED', row };
  const claimed = await prisma.youTubeVideoLike.updateMany({
    where: {
      id: row.id,
      status: 'PENDING',
      leaseVersion: row.leaseVersion,
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }],
    },
    data: { ownerId, lockedUntil, leaseVersion: { increment: 1 }, lastErrorCode: null },
  });
  if (!claimed.count) return { state: 'BUSY' };
  const owned = await prisma.youTubeVideoLike.findUnique({ where: { id: row.id } });
  return { state: 'CLAIMED', claim: { id: row.id, ownerId, leaseVersion: owned.leaseVersion, userId, videoId } };
}

async function recordVideoLiked(prisma, userId, videoId) {
  return prisma.youTubeVideoLike.upsert({
    where: { userId_videoId: { userId, videoId } },
    create: { userId, videoId, status: 'LIKED', likedAt: new Date() },
    update: { status: 'LIKED', likedAt: new Date(), ownerId: null, lockedUntil: null, lastErrorCode: null },
  });
}

async function completeVideoLike(prisma, claim) {
  return prisma.youTubeVideoLike.updateMany({
    where: { id: claim.id, status: 'PENDING', ownerId: claim.ownerId, leaseVersion: claim.leaseVersion },
    data: { status: 'LIKED', likedAt: new Date(), ownerId: null, lockedUntil: null, lastErrorCode: null },
  });
}

async function releaseVideoLike(prisma, claim, errorCode = null) {
  if (!claim) return { count: 0 };
  return prisma.youTubeVideoLike.updateMany({
    where: { id: claim.id, status: 'PENDING', ownerId: claim.ownerId, leaseVersion: claim.leaseVersion },
    data: { ownerId: null, lockedUntil: null, lastErrorCode: errorCode },
  });
}

module.exports = { tryClaimVideoLike, recordVideoLiked, completeVideoLike, releaseVideoLike };
