-- CreateEnum
CREATE TYPE "OAuthProvider" AS ENUM ('SPOTIFY', 'GOOGLE');
CREATE TYPE "MigrationStatus" AS ENUM ('DRAFT', 'SCANNING', 'READY', 'QUEUED', 'RUNNING', 'PAUSED', 'AUTHENTICATION_REQUIRED', 'QUOTA_PAUSED', 'COMPLETED', 'FAILED');
CREATE TYPE "MigrationTrackStatus" AS ENUM ('PENDING', 'SCANNING', 'READY', 'REVIEW', 'LIKING', 'LIKED', 'ALREADY_LIKED', 'SKIPPED', 'NOT_FOUND', 'FAILED');

CREATE TABLE "User" ("id" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "User_pkey" PRIMARY KEY ("id"));
CREATE TABLE "SpotifyConnection" ("id" TEXT NOT NULL, "userId" TEXT NOT NULL, "providerAccountId" TEXT NOT NULL, "accountName" TEXT, "encryptedAccessToken" TEXT NOT NULL, "encryptedRefreshToken" TEXT, "expiresAt" TIMESTAMP(3), "scopes" TEXT[], "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "SpotifyConnection_pkey" PRIMARY KEY ("id"));
CREATE TABLE "YouTubeConnection" ("id" TEXT NOT NULL, "userId" TEXT NOT NULL, "providerAccountId" TEXT NOT NULL, "accountName" TEXT, "encryptedAccessToken" TEXT NOT NULL, "encryptedRefreshToken" TEXT, "expiresAt" TIMESTAMP(3), "scopes" TEXT[], "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "YouTubeConnection_pkey" PRIMARY KEY ("id"));
CREATE TABLE "AppSession" ("id" TEXT NOT NULL, "userId" TEXT NOT NULL, "tokenHash" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "AppSession_pkey" PRIMARY KEY ("id"));
CREATE TABLE "OAuthState" ("id" TEXT NOT NULL, "userId" TEXT, "provider" "OAuthProvider" NOT NULL, "stateHash" TEXT NOT NULL, "encryptedCodeVerifier" TEXT NOT NULL, "returnTo" TEXT NOT NULL DEFAULT '/connections', "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("id"));
CREATE TABLE "Migration" ("id" TEXT NOT NULL, "userId" TEXT NOT NULL, "source" TEXT NOT NULL DEFAULT 'spotify', "destination" TEXT NOT NULL DEFAULT 'youtube_music', "status" "MigrationStatus" NOT NULL DEFAULT 'DRAFT', "totalTracks" INTEGER NOT NULL DEFAULT 0, "processedTracks" INTEGER NOT NULL DEFAULT 0, "confidentCount" INTEGER NOT NULL DEFAULT 0, "likedCount" INTEGER NOT NULL DEFAULT 0, "alreadyLikedCount" INTEGER NOT NULL DEFAULT 0, "reviewCount" INTEGER NOT NULL DEFAULT 0, "notFoundCount" INTEGER NOT NULL DEFAULT 0, "failedCount" INTEGER NOT NULL DEFAULT 0, "skippedCount" INTEGER NOT NULL DEFAULT 0, "currentTrackTitle" TEXT, "currentTrackArtist" TEXT, "lastErrorCode" TEXT, "lastErrorMessage" TEXT, "startedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3), "lockedUntil" TIMESTAMP(3), "workerId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "Migration_pkey" PRIMARY KEY ("id"));
CREATE TABLE "MigrationTrack" ("id" TEXT NOT NULL, "migrationId" TEXT NOT NULL, "position" INTEGER NOT NULL, "spotifyTrackId" TEXT NOT NULL, "spotifyTitle" TEXT NOT NULL, "spotifyArtists" TEXT[], "spotifyAlbum" TEXT, "spotifyDurationMs" INTEGER, "spotifyUrl" TEXT, "matchedYoutubeVideoId" TEXT, "matchedYoutubeTitle" TEXT, "matchedYoutubeArtists" TEXT[], "confidence" TEXT, "score" DOUBLE PRECISION, "reason" TEXT, "status" "MigrationTrackStatus" NOT NULL DEFAULT 'PENDING', "retryCount" INTEGER NOT NULL DEFAULT 0, "errorCode" TEXT, "errorMessage" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "MigrationTrack_pkey" PRIMARY KEY ("id"));
CREATE TABLE "MigrationCandidate" ("id" TEXT NOT NULL, "trackId" TEXT NOT NULL, "position" INTEGER NOT NULL, "videoId" TEXT NOT NULL, "title" TEXT NOT NULL, "artists" TEXT[], "album" TEXT, "durationMs" INTEGER, "resultType" TEXT, "videoType" TEXT, "score" DOUBLE PRECISION NOT NULL, "reasons" TEXT[], "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "MigrationCandidate_pkey" PRIMARY KEY ("id"));

CREATE UNIQUE INDEX "SpotifyConnection_userId_key" ON "SpotifyConnection"("userId");
CREATE UNIQUE INDEX "SpotifyConnection_providerAccountId_key" ON "SpotifyConnection"("providerAccountId");
CREATE UNIQUE INDEX "YouTubeConnection_userId_key" ON "YouTubeConnection"("userId");
CREATE UNIQUE INDEX "YouTubeConnection_providerAccountId_key" ON "YouTubeConnection"("providerAccountId");
CREATE UNIQUE INDEX "AppSession_tokenHash_key" ON "AppSession"("tokenHash");
CREATE INDEX "AppSession_userId_idx" ON "AppSession"("userId");
CREATE INDEX "AppSession_expiresAt_idx" ON "AppSession"("expiresAt");
CREATE UNIQUE INDEX "OAuthState_stateHash_key" ON "OAuthState"("stateHash");
CREATE INDEX "OAuthState_expiresAt_idx" ON "OAuthState"("expiresAt");
CREATE INDEX "Migration_userId_createdAt_idx" ON "Migration"("userId", "createdAt");
CREATE INDEX "Migration_status_lockedUntil_idx" ON "Migration"("status", "lockedUntil");
CREATE UNIQUE INDEX "MigrationTrack_migrationId_spotifyTrackId_key" ON "MigrationTrack"("migrationId", "spotifyTrackId");
CREATE INDEX "MigrationTrack_migrationId_status_position_idx" ON "MigrationTrack"("migrationId", "status", "position");
CREATE UNIQUE INDEX "MigrationCandidate_trackId_position_key" ON "MigrationCandidate"("trackId", "position");
CREATE INDEX "MigrationCandidate_trackId_idx" ON "MigrationCandidate"("trackId");

ALTER TABLE "SpotifyConnection" ADD CONSTRAINT "SpotifyConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "YouTubeConnection" ADD CONSTRAINT "YouTubeConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppSession" ADD CONSTRAINT "AppSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OAuthState" ADD CONSTRAINT "OAuthState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Migration" ADD CONSTRAINT "Migration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MigrationTrack" ADD CONSTRAINT "MigrationTrack_migrationId_fkey" FOREIGN KEY ("migrationId") REFERENCES "Migration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MigrationCandidate" ADD CONSTRAINT "MigrationCandidate_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "MigrationTrack"("id") ON DELETE CASCADE ON UPDATE CASCADE;
