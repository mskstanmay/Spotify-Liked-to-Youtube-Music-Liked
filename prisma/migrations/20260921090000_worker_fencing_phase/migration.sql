-- Persist the active migration phase independently from pause/error status and
-- add a monotonically increasing fencing value for worker leases.
CREATE TYPE "MigrationPhase" AS ENUM ('SCANNING', 'LIKING');

ALTER TABLE "Migration"
  ADD COLUMN "phase" "MigrationPhase" NOT NULL DEFAULT 'SCANNING',
  ADD COLUMN "leaseVersion" INTEGER NOT NULL DEFAULT 0;

-- Backfill phases for migrations created before the explicit phase existed.
UPDATE "Migration"
SET "phase" = 'LIKING'
WHERE "status" IN ('READY', 'QUEUED', 'RUNNING', 'QUOTA_PAUSED', 'COMPLETED')
   OR (
     "status" = 'PAUSED'
     AND EXISTS (
       SELECT 1 FROM "MigrationTrack"
       WHERE "MigrationTrack"."migrationId" = "Migration"."id"
     )
   )
   OR (
     "status" IN ('AUTHENTICATION_REQUIRED', 'FAILED')
     AND EXISTS (
       SELECT 1 FROM "MigrationTrack"
       WHERE "MigrationTrack"."migrationId" = "Migration"."id"
     )
     AND NOT EXISTS (
       SELECT 1 FROM "MigrationTrack"
       WHERE "MigrationTrack"."migrationId" = "Migration"."id"
         AND "MigrationTrack"."status" IN ('PENDING', 'SCANNING')
     )
   );

DROP INDEX "Migration_status_lockedUntil_idx";
CREATE INDEX "Migration_status_lockedUntil_leaseVersion_idx"
  ON "Migration"("status", "lockedUntil", "leaseVersion");
