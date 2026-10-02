CREATE TYPE "YouTubeVideoLikeStatus" AS ENUM ('PENDING', 'LIKED');

ALTER TABLE "YouTubeConnection"
  ADD COLUMN "refreshVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "refreshOwner" TEXT,
  ADD COLUMN "refreshLockedUntil" TIMESTAMP(3);

CREATE INDEX "YouTubeConnection_refreshLockedUntil_idx"
  ON "YouTubeConnection"("refreshLockedUntil");

CREATE TABLE "YouTubeVideoLike" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "videoId" TEXT NOT NULL,
  "status" "YouTubeVideoLikeStatus" NOT NULL DEFAULT 'PENDING',
  "ownerId" TEXT,
  "lockedUntil" TIMESTAMP(3),
  "leaseVersion" INTEGER NOT NULL DEFAULT 0,
  "lastErrorCode" TEXT,
  "likedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "YouTubeVideoLike_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "YouTubeVideoLike_userId_videoId_key"
  ON "YouTubeVideoLike"("userId", "videoId");
CREATE INDEX "YouTubeVideoLike_status_lockedUntil_idx"
  ON "YouTubeVideoLike"("status", "lockedUntil");
ALTER TABLE "YouTubeVideoLike"
  ADD CONSTRAINT "YouTubeVideoLike_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WorkerRuntime" (
  "id" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkerRuntime_pkey" PRIMARY KEY ("id")
);
