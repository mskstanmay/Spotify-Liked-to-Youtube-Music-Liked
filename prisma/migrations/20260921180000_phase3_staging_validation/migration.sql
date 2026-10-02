CREATE TYPE "ProviderConnectionStatus" AS ENUM ('ACTIVE', 'AUTHENTICATION_INVALID', 'RECONNECT_REQUIRED');

ALTER TABLE "SpotifyConnection"
  ADD COLUMN "connectionStatus" "ProviderConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "lastAuthErrorCode" TEXT,
  ADD COLUMN "authInvalidAt" TIMESTAMP(3);

ALTER TABLE "YouTubeConnection"
  ADD COLUMN "connectionStatus" "ProviderConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "lastAuthErrorCode" TEXT,
  ADD COLUMN "authInvalidAt" TIMESTAMP(3);

ALTER TABLE "Migration"
  ADD COLUMN "sourceTotalTracks" INTEGER,
  ADD COLUMN "trackLimit" INTEGER;

ALTER TABLE "Migration"
  ADD CONSTRAINT "Migration_trackLimit_check" CHECK ("trackLimit" IS NULL OR "trackLimit" > 0),
  ADD CONSTRAINT "Migration_sourceTotalTracks_check" CHECK ("sourceTotalTracks" IS NULL OR "sourceTotalTracks" >= 0);
