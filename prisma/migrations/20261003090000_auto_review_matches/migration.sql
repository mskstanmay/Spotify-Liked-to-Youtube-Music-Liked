ALTER TABLE "MigrationTrack"
  ADD COLUMN "needsReview" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "MigrationTrack_migrationId_needsReview_status_idx"
  ON "MigrationTrack"("migrationId", "needsReview", "status");
