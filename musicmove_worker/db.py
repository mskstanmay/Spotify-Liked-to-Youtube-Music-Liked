from __future__ import annotations

import os
import secrets
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

from psycopg import Connection, sql
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .state import counter_data, persisted_counter_data

CLAIMABLE_STATUSES = ("SCANNING", "QUEUED", "RUNNING")


class LeaseLostError(RuntimeError):
    code = "WORKER_LEASE_LOST"

    def __init__(self) -> None:
        super().__init__("The migration lease is no longer owned by this worker.")


def utcnow() -> datetime:
    # Prisma/JavaScript Date and PostgreSQL TIMESTAMP(3) both operate at
    # millisecond precision in this application.
    value = datetime.now(UTC).replace(tzinfo=None)
    return value.replace(microsecond=(value.microsecond // 1_000) * 1_000)


_id_lock = threading.Lock()
_id_counter = 0


def _base36(value: int) -> str:
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
    output = ""
    while value:
        value, remainder = divmod(value, 36)
        output = alphabet[remainder] + output
    return output or "0"


def new_id() -> str:
    """Return an opaque, CUID-shaped identifier for direct SQL inserts."""
    global _id_counter
    with _id_lock:
        _id_counter = (_id_counter + 1) % (36**4)
        counter = _base36(_id_counter).rjust(4, "0")
    stamp = _base36(int(time.time() * 1_000)).rjust(8, "0")[-8:]
    process = _base36(os.getpid() % (36**4)).rjust(4, "0")
    random_part = "".join(
        secrets.choice("0123456789abcdefghijklmnopqrstuvwxyz") for _ in range(8)
    )
    return f"c{stamp}{counter}{process}{random_part}"


MIGRATION_FIELDS = {
    "status",
    "phase",
    "totalTracks",
    "sourceTotalTracks",
    "processedTracks",
    "confidentCount",
    "likedCount",
    "alreadyLikedCount",
    "reviewCount",
    "notFoundCount",
    "failedCount",
    "skippedCount",
    "currentTrackTitle",
    "currentTrackArtist",
    "lastErrorCode",
    "lastErrorMessage",
    "startedAt",
    "completedAt",
    "lockedUntil",
    "workerId",
}


def _assignment(field: str):
    identifier = sql.Identifier(field)
    if field == "status":
        return sql.SQL('{} = CAST(%s AS "MigrationStatus")').format(identifier)
    if field == "phase":
        return sql.SQL('{} = CAST(%s AS "MigrationPhase")').format(identifier)
    return sql.SQL("{} = %s").format(identifier)


class Database:
    def __init__(
        self, database_url: str, *, min_size: int = 1, max_size: int = 6
    ) -> None:
        self.pool = ConnectionPool(
            conninfo=database_url,
            min_size=min_size,
            max_size=max_size,
            kwargs={"row_factory": dict_row},
            check=ConnectionPool.check_connection,
            open=False,
        )

    def open(self) -> None:
        self.pool.open(wait=True)

    def close(self) -> None:
        self.pool.close()

    def report_runtime(self, worker_id: str) -> None:
        with self.pool.connection() as connection:
            connection.execute(
                """
                INSERT INTO "WorkerRuntime" ("id", "startedAt", "updatedAt")
                VALUES (%s, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ON CONFLICT ("id") DO UPDATE SET "updatedAt" = CURRENT_TIMESTAMP
                """,
                (worker_id,),
            )

    def remove_runtime(self, worker_id: str) -> None:
        with self.pool.connection() as connection:
            connection.execute(
                'DELETE FROM "WorkerRuntime" WHERE "id" = %s', (worker_id,)
            )

    def claim_migration(self, worker_id: str, lease_ms: int) -> dict | None:
        now = utcnow()
        locked_until = now + timedelta(milliseconds=lease_ms)
        with self.pool.connection() as connection, connection.transaction():
            candidate = connection.execute(
                """
                SELECT * FROM "Migration"
                WHERE (
                    ("status" = 'SCANNING' AND "phase" = 'SCANNING')
                    OR ("status" IN ('QUEUED', 'RUNNING') AND "phase" = 'LIKING')
                )
                AND ("lockedUntil" IS NULL OR "lockedUntil" < %s)
                ORDER BY "updatedAt" ASC
                LIMIT 1
                """,
                (now,),
            ).fetchone()
            if not candidate:
                return None
            claimed = connection.execute(
                """
                UPDATE "Migration"
                SET "workerId" = %s, "lockedUntil" = %s,
                    "leaseVersion" = "leaseVersion" + 1, "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = %s
                  AND "status" = %s::"MigrationStatus"
                  AND "phase" = %s::"MigrationPhase"
                  AND "leaseVersion" = %s
                  AND ("lockedUntil" IS NULL OR "lockedUntil" < %s)
                RETURNING *
                """,
                (
                    worker_id,
                    locked_until,
                    candidate["id"],
                    candidate["status"],
                    candidate["phase"],
                    candidate["leaseVersion"],
                    now,
                ),
            ).fetchone()
            return dict(claimed) if claimed else None

    def renew_lease(self, job: dict, worker_id: str, lease_ms: int) -> datetime:
        if job.get("leaseLost"):
            raise LeaseLostError()
        now = utcnow()
        locked_until = now + timedelta(milliseconds=lease_ms)
        try:
            with self.pool.connection() as connection, connection.transaction():
                renewed = connection.execute(
                    """
                    UPDATE "Migration"
                    SET "lockedUntil" = %s, "updatedAt" = CURRENT_TIMESTAMP
                    WHERE "id" = %s AND "workerId" = %s AND "leaseVersion" = %s
                      AND "status" IN ('SCANNING', 'QUEUED', 'RUNNING')
                      AND "lockedUntil" > %s
                    RETURNING "id"
                    """,
                    (locked_until, job["id"], worker_id, job["leaseVersion"], now),
                ).fetchone()
                if not renewed:
                    job["leaseLost"] = True
                    raise LeaseLostError()
                claim = job.get("videoClaim")
                if claim:
                    video_renewed = connection.execute(
                        """
                        UPDATE "YouTubeVideoLike"
                        SET "lockedUntil" = %s, "updatedAt" = CURRENT_TIMESTAMP
                        WHERE "id" = %s AND "status" = 'PENDING'
                          AND "ownerId" = %s AND "leaseVersion" = %s
                          AND "lockedUntil" > %s
                        RETURNING "id"
                        """,
                        (
                            locked_until,
                            claim["id"],
                            claim["ownerId"],
                            claim["leaseVersion"],
                            now,
                        ),
                    ).fetchone()
                    if not video_renewed:
                        job["leaseLost"] = True
                        raise LeaseLostError()
                connection.execute(
                    """
                    INSERT INTO "WorkerRuntime" ("id", "startedAt", "updatedAt")
                    VALUES (%s, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    ON CONFLICT ("id") DO UPDATE SET "updatedAt" = CURRENT_TIMESTAMP
                    """,
                    (worker_id,),
                )
        except Exception:
            job["leaseLost"] = True
            raise
        job["lockedUntil"] = locked_until
        return locked_until

    def owns(
        self, job: dict, worker_id: str, statuses: tuple[str, ...] | list[str]
    ) -> bool:
        if job.get("leaseLost"):
            return False
        with self.pool.connection() as connection:
            row = connection.execute(
                """
                SELECT "id" FROM "Migration"
                WHERE "id" = %s AND "workerId" = %s AND "leaseVersion" = %s
                  AND "status"::text = ANY(%s) AND "lockedUntil" > %s
                """,
                (job["id"], worker_id, job["leaseVersion"], list(statuses), utcnow()),
            ).fetchone()
        if not row:
            job["leaseLost"] = True
        return bool(row)

    def release_migration(self, job: dict, worker_id: str) -> None:
        claim = job.get("videoClaim")
        with self.pool.connection() as connection, connection.transaction():
            if claim:
                self.release_video_like(connection, claim)
            connection.execute(
                """
                UPDATE "Migration"
                SET "workerId" = NULL, "lockedUntil" = NULL, "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = %s AND "workerId" = %s AND "leaseVersion" = %s
                """,
                (job["id"], worker_id, job["leaseVersion"]),
            )
        job["videoClaim"] = None

    @contextmanager
    def fenced(
        self,
        job: dict,
        worker_id: str,
        statuses: tuple[str, ...] | list[str],
        lease_ms: int,
    ) -> Iterator[Connection]:
        if job.get("leaseLost"):
            raise LeaseLostError()
        now = utcnow()
        locked_until = now + timedelta(milliseconds=lease_ms)
        with self.pool.connection() as connection, connection.transaction():
            row = connection.execute(
                """
                UPDATE "Migration"
                SET "lockedUntil" = %s, "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = %s AND "workerId" = %s AND "leaseVersion" = %s
                  AND "status"::text = ANY(%s) AND "lockedUntil" > %s
                RETURNING "id"
                """,
                (
                    locked_until,
                    job["id"],
                    worker_id,
                    job["leaseVersion"],
                    list(statuses),
                    now,
                ),
            ).fetchone()
            if not row:
                job["leaseLost"] = True
                raise LeaseLostError()
            job["lockedUntil"] = locked_until
            yield connection

    def update_migration_row(
        self, connection: Connection, migration_id: str, fields: dict
    ) -> None:
        unknown = set(fields) - MIGRATION_FIELDS
        if unknown:
            raise ValueError(f"Unsupported Migration fields: {sorted(unknown)}")
        if not fields:
            return
        assignments = [_assignment(field) for field in fields]
        assignments.append(sql.SQL('"updatedAt" = CURRENT_TIMESTAMP'))
        query = sql.SQL('UPDATE "Migration" SET {} WHERE "id" = %s').format(
            sql.SQL(", ").join(assignments)
        )
        connection.execute(query, (*fields.values(), migration_id))

    def update_migration(
        self,
        job: dict,
        worker_id: str,
        statuses: list[str],
        lease_ms: int,
        fields: dict,
    ) -> None:
        with self.fenced(job, worker_id, statuses, lease_ms) as connection:
            self.update_migration_row(connection, job["id"], fields)

    def get_spotify_connection(self, user_id: str) -> dict | None:
        with self.pool.connection() as connection:
            row = connection.execute(
                'SELECT * FROM "SpotifyConnection" WHERE "userId" = %s', (user_id,)
            ).fetchone()
            return dict(row) if row else None

    def get_youtube_connection(self, user_id: str) -> dict | None:
        with self.pool.connection() as connection:
            row = connection.execute(
                'SELECT * FROM "YouTubeConnection" WHERE "userId" = %s', (user_id,)
            ).fetchone()
            return dict(row) if row else None

    def get_youtube_connection_by_id(self, connection_id: str) -> dict | None:
        with self.pool.connection() as connection:
            row = connection.execute(
                'SELECT * FROM "YouTubeConnection" WHERE "id" = %s', (connection_id,)
            ).fetchone()
            return dict(row) if row else None

    def get_spotify_connection_by_id(self, connection_id: str) -> dict | None:
        with self.pool.connection() as connection:
            row = connection.execute(
                'SELECT * FROM "SpotifyConnection" WHERE "id" = %s', (connection_id,)
            ).fetchone()
            return dict(row) if row else None

    def mark_connection_health(
        self, table: str, connection_id: str, status: str, error_code: str | None
    ) -> None:
        if table not in {"SpotifyConnection", "YouTubeConnection"}:
            raise ValueError("Unsupported connection table")
        invalid_at = None if status == "ACTIVE" else utcnow()
        query = sql.SQL(
            'UPDATE {} SET "connectionStatus" = %s::"ProviderConnectionStatus", '
            '"lastAuthErrorCode" = %s, "authInvalidAt" = %s, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = %s'
        ).format(sql.Identifier(table))
        with self.pool.connection() as connection:
            connection.execute(query, (status, error_code, invalid_at, connection_id))

    def save_spotify_tokens(self, connection_id: str, data: dict) -> None:
        with self.pool.connection() as connection:
            connection.execute(
                """
                UPDATE "SpotifyConnection"
                SET "encryptedAccessToken" = %s, "encryptedRefreshToken" = %s,
                    "expiresAt" = %s, "scopes" = %s,
                    "connectionStatus" = 'ACTIVE', "lastAuthErrorCode" = NULL,
                    "authInvalidAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = %s
                """,
                (
                    data["encryptedAccessToken"],
                    data["encryptedRefreshToken"],
                    data["expiresAt"],
                    data["scopes"],
                    connection_id,
                ),
            )

    def try_claim_youtube_refresh(
        self, connection_id: str, version: int, owner: str, locked_until: datetime
    ) -> bool:
        with self.pool.connection() as connection:
            row = connection.execute(
                """
                UPDATE "YouTubeConnection"
                SET "refreshOwner" = %s, "refreshLockedUntil" = %s, "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = %s AND "refreshVersion" = %s
                  AND ("refreshLockedUntil" IS NULL OR "refreshLockedUntil" < %s)
                RETURNING "id"
                """,
                (owner, locked_until, connection_id, version, utcnow()),
            ).fetchone()
            return bool(row)

    def save_youtube_refresh(
        self, connection_id: str, version: int, owner: str, data: dict
    ) -> bool:
        with self.pool.connection() as connection:
            row = connection.execute(
                """
                UPDATE "YouTubeConnection"
                SET "encryptedAccessToken" = %s, "encryptedRefreshToken" = %s,
                    "expiresAt" = %s, "scopes" = %s,
                    "connectionStatus" = 'ACTIVE', "lastAuthErrorCode" = NULL,
                    "authInvalidAt" = NULL, "refreshVersion" = "refreshVersion" + 1,
                    "refreshOwner" = NULL, "refreshLockedUntil" = NULL,
                    "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = %s AND "refreshOwner" = %s AND "refreshVersion" = %s
                RETURNING "id"
                """,
                (
                    data["encryptedAccessToken"],
                    data["encryptedRefreshToken"],
                    data["expiresAt"],
                    data["scopes"],
                    connection_id,
                    owner,
                    version,
                ),
            ).fetchone()
            return bool(row)

    def release_youtube_refresh(self, connection_id: str, owner: str) -> None:
        with self.pool.connection() as connection:
            connection.execute(
                """
                UPDATE "YouTubeConnection"
                SET "refreshOwner" = NULL, "refreshLockedUntil" = NULL, "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = %s AND "refreshOwner" = %s
                """,
                (connection_id, owner),
            )

    def migration_track_count(self, migration_id: str) -> int:
        with self.pool.connection() as connection:
            return int(
                connection.execute(
                    'SELECT COUNT(*) AS count FROM "MigrationTrack" WHERE "migrationId" = %s',
                    (migration_id,),
                ).fetchone()["count"]
            )

    def insert_spotify_tracks(
        self,
        connection: Connection,
        migration_id: str,
        tracks: list[dict],
    ) -> None:
        if not tracks:
            return
        rows = [
            (
                new_id(),
                migration_id,
                position,
                track["spotifyTrackId"],
                track["title"],
                track["artists"],
                track.get("album"),
                track.get("durationMs"),
                track.get("spotifyUrl"),
            )
            for position, track in enumerate(tracks, 1)
        ]
        connection.executemany(
            """
            INSERT INTO "MigrationTrack" (
                "id", "migrationId", "position", "spotifyTrackId", "spotifyTitle",
                "spotifyArtists", "spotifyAlbum", "spotifyDurationMs", "spotifyUrl",
                "matchedYoutubeArtists", "createdAt", "updatedAt"
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT ("migrationId", "spotifyTrackId") DO NOTHING
            """,
            rows,
        )

    def finalize_spotify_fetch(
        self,
        job: dict,
        worker_id: str,
        lease_ms: int,
        tracks: list[dict],
        source_total: int,
    ) -> None:
        with self.fenced(job, worker_id, ["SCANNING"], lease_ms) as connection:
            self.insert_spotify_tracks(connection, job["id"], tracks)
            count = connection.execute(
                'SELECT COUNT(*) AS count FROM "MigrationTrack" WHERE "migrationId" = %s',
                (job["id"],),
            ).fetchone()["count"]
            self.update_migration_row(
                connection,
                job["id"],
                {"totalTracks": count, "sourceTotalTracks": source_total},
            )

    def next_scan_track(self, migration_id: str) -> dict | None:
        with self.pool.connection() as connection:
            row = connection.execute(
                """
                SELECT * FROM "MigrationTrack"
                WHERE "migrationId" = %s AND "status" IN ('PENDING', 'SCANNING')
                ORDER BY "position" ASC LIMIT 1
                """,
                (migration_id,),
            ).fetchone()
            return dict(row) if row else None

    def begin_scan_track(
        self, job: dict, worker_id: str, lease_ms: int, track: dict
    ) -> bool:
        with self.fenced(job, worker_id, ["SCANNING"], lease_ms) as connection:
            changed = connection.execute(
                """
                UPDATE "MigrationTrack"
                SET "status" = 'SCANNING', "errorCode" = NULL, "errorMessage" = NULL,
                    "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = %s AND "migrationId" = %s AND "status" IN ('PENDING', 'SCANNING')
                RETURNING "id"
                """,
                (track["id"], job["id"]),
            ).fetchone()
            if not changed:
                return False
            self.update_migration_row(
                connection,
                job["id"],
                {
                    "currentTrackTitle": track["spotifyTitle"],
                    "currentTrackArtist": ", ".join(track["spotifyArtists"]),
                },
            )
            return True

    def _counter_data(
        self, connection: Connection, migration_id: str, phase: str
    ) -> dict:
        groups = connection.execute(
            """
            SELECT "status"::text AS status, "needsReview", COUNT(*)::int AS count
            FROM "MigrationTrack" WHERE "migrationId" = %s
            GROUP BY "status", "needsReview"
            """,
            (migration_id,),
        ).fetchall()
        matched = connection.execute(
            """
            SELECT COUNT(*)::int AS count FROM "MigrationTrack"
            WHERE "migrationId" = %s AND "matchedYoutubeVideoId" IS NOT NULL
            """,
            (migration_id,),
        ).fetchone()["count"]
        return counter_data([dict(row) for row in groups], matched, phase)

    def refresh_counts(
        self, connection: Connection, migration_id: str, phase: str
    ) -> dict:
        counters = self._counter_data(connection, migration_id, phase)
        self.update_migration_row(
            connection, migration_id, persisted_counter_data(counters)
        )
        return counters

    def save_scan_result(
        self,
        job: dict,
        worker_id: str,
        lease_ms: int,
        track: dict,
        result_data: dict,
        candidates: list[dict],
    ) -> None:
        with self.fenced(job, worker_id, ["SCANNING"], lease_ms) as connection:
            connection.execute(
                'DELETE FROM "MigrationCandidate" WHERE "trackId" = %s', (track["id"],)
            )
            rows = []
            for position, candidate in enumerate(candidates[:10]):
                rows.append(
                    (
                        new_id(),
                        track["id"],
                        position,
                        candidate["videoId"],
                        candidate.get("title") or "Untitled",
                        candidate.get("artists") or [],
                        candidate.get("album"),
                        candidate.get("durationMs"),
                        candidate.get("resultType"),
                        candidate.get("videoType"),
                        candidate.get("score", 0),
                        candidate.get("reasons") or [],
                    )
                )
            if rows:
                connection.executemany(
                    """
                    INSERT INTO "MigrationCandidate" (
                        "id", "trackId", "position", "videoId", "title", "artists", "album",
                        "durationMs", "resultType", "videoType", "score", "reasons", "createdAt"
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, CURRENT_TIMESTAMP)
                    """,
                    rows,
                )
            track_fields = ["needsReview", "reason"]
            track_fields.extend(
                field
                for field in (
                    "matchedYoutubeVideoId",
                    "matchedYoutubeTitle",
                    "matchedYoutubeArtists",
                    "confidence",
                    "score",
                )
                if field in result_data
            )
            assignments = [sql.SQL('"status" = CAST(%s AS "MigrationTrackStatus")')]
            assignments.extend(
                sql.SQL("{} = %s").format(sql.Identifier(field))
                for field in track_fields
            )
            assignments.append(sql.SQL('"updatedAt" = CURRENT_TIMESTAMP'))
            query = sql.SQL(
                'UPDATE "MigrationTrack" SET {} '
                'WHERE "id" = %s AND "migrationId" = %s AND "status" = \'SCANNING\''
            ).format(sql.SQL(", ").join(assignments))
            connection.execute(
                query,
                (
                    result_data["status"],
                    *(result_data.get(field) for field in track_fields),
                    track["id"],
                    job["id"],
                ),
            )
            self.refresh_counts(connection, job["id"], "SCANNING")

    def fail_scan_track(
        self, job: dict, worker_id: str, lease_ms: int, track_id: str
    ) -> None:
        with self.fenced(job, worker_id, ["SCANNING"], lease_ms) as connection:
            connection.execute(
                """
                UPDATE "MigrationTrack"
                SET "status" = 'FAILED', "errorCode" = 'SEARCH_FAILED',
                    "errorMessage" = 'We could not search YouTube Music for this track.',
                    "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = %s AND "migrationId" = %s AND "status" = 'SCANNING'
                """,
                (track_id, job["id"]),
            )
            self.refresh_counts(connection, job["id"], "SCANNING")

    def finish_scanning(self, job: dict, worker_id: str, lease_ms: int) -> bool:
        with self.fenced(job, worker_id, ["SCANNING"], lease_ms) as connection:
            remaining = connection.execute(
                """
                SELECT COUNT(*)::int AS count FROM "MigrationTrack"
                WHERE "migrationId" = %s AND "status" IN ('PENDING', 'SCANNING')
                """,
                (job["id"],),
            ).fetchone()["count"]
            if remaining:
                return False
            counters = persisted_counter_data(
                self._counter_data(connection, job["id"], "SCANNING")
            )
            self.update_migration_row(
                connection,
                job["id"],
                {
                    **counters,
                    "status": "QUEUED" if job.get("startedAt") else "READY",
                    "phase": "LIKING",
                    "currentTrackTitle": None,
                    "currentTrackArtist": None,
                },
            )
            return True

    def begin_migration(self, job: dict, worker_id: str, lease_ms: int) -> None:
        with self.fenced(job, worker_id, ["QUEUED", "RUNNING"], lease_ms) as connection:
            counters = persisted_counter_data(
                self._counter_data(connection, job["id"], "LIKING")
            )
            self.update_migration_row(
                connection,
                job["id"],
                {
                    **counters,
                    "status": "RUNNING",
                    "phase": "LIKING",
                    "startedAt": job.get("startedAt") or utcnow(),
                },
            )
        job["status"] = "RUNNING"
        job["phase"] = "LIKING"

    def pending_like_tracks(self, migration_id: str) -> list[dict]:
        with self.pool.connection() as connection:
            return [
                dict(row)
                for row in connection.execute(
                    """
                    SELECT * FROM "MigrationTrack"
                    WHERE "migrationId" = %s AND "status" IN ('READY', 'LIKING')
                    ORDER BY "position" ASC
                    """,
                    (migration_id,),
                ).fetchall()
            ]

    def update_current_track(
        self, job: dict, worker_id: str, lease_ms: int, track: dict
    ) -> None:
        self.update_migration(
            job,
            worker_id,
            ["RUNNING"],
            lease_ms,
            {
                "currentTrackTitle": track["spotifyTitle"],
                "currentTrackArtist": ", ".join(track["spotifyArtists"]),
            },
        )

    def record_video_liked(
        self, connection: Connection, user_id: str, video_id: str
    ) -> None:
        connection.execute(
            """
            INSERT INTO "YouTubeVideoLike" (
                "id", "userId", "videoId", "status", "likedAt", "createdAt", "updatedAt"
            ) VALUES (%s, %s, %s, 'LIKED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT ("userId", "videoId") DO UPDATE SET
                "status" = 'LIKED', "likedAt" = CURRENT_TIMESTAMP,
                "ownerId" = NULL, "lockedUntil" = NULL, "lastErrorCode" = NULL,
                "updatedAt" = CURRENT_TIMESTAMP
            """,
            (new_id(), user_id, video_id),
        )

    def mark_initial_already_liked(
        self, job: dict, worker_id: str, lease_ms: int, track: dict
    ) -> None:
        with self.fenced(job, worker_id, ["RUNNING"], lease_ms) as connection:
            self.record_video_liked(
                connection, job["userId"], track["matchedYoutubeVideoId"]
            )
            connection.execute(
                """
                UPDATE "MigrationTrack"
                SET "status" = 'ALREADY_LIKED', "errorCode" = NULL, "errorMessage" = NULL,
                    "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = %s AND "migrationId" = %s AND "status" IN ('READY', 'LIKING')
                """,
                (track["id"], job["id"]),
            )

    def begin_like_track(
        self, job: dict, worker_id: str, lease_ms: int, track_id: str
    ) -> bool:
        with self.fenced(job, worker_id, ["RUNNING"], lease_ms) as connection:
            row = connection.execute(
                """
                UPDATE "MigrationTrack" SET "status" = 'LIKING', "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = %s AND "migrationId" = %s AND "status" IN ('READY', 'LIKING')
                RETURNING "id"
                """,
                (track_id, job["id"]),
            ).fetchone()
            return bool(row)

    def try_claim_video_like(
        self, user_id: str, video_id: str, owner_id: str, locked_until: datetime
    ) -> dict:
        with self.pool.connection() as connection, connection.transaction():
            connection.execute(
                """
                INSERT INTO "YouTubeVideoLike" (
                    "id", "userId", "videoId", "createdAt", "updatedAt"
                ) VALUES (%s, %s, %s, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ON CONFLICT ("userId", "videoId") DO NOTHING
                """,
                (new_id(), user_id, video_id),
            )
            row = connection.execute(
                'SELECT * FROM "YouTubeVideoLike" WHERE "userId" = %s AND "videoId" = %s',
                (user_id, video_id),
            ).fetchone()
            if row["status"] == "LIKED":
                return {"state": "LIKED", "row": dict(row)}
            claimed = connection.execute(
                """
                UPDATE "YouTubeVideoLike"
                SET "ownerId" = %s, "lockedUntil" = %s,
                    "leaseVersion" = "leaseVersion" + 1, "lastErrorCode" = NULL,
                    "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = %s AND "status" = 'PENDING' AND "leaseVersion" = %s
                  AND ("lockedUntil" IS NULL OR "lockedUntil" < %s)
                RETURNING *
                """,
                (owner_id, locked_until, row["id"], row["leaseVersion"], utcnow()),
            ).fetchone()
            if not claimed:
                return {"state": "BUSY"}
            return {
                "state": "CLAIMED",
                "claim": {
                    "id": claimed["id"],
                    "ownerId": owner_id,
                    "leaseVersion": claimed["leaseVersion"],
                    "userId": user_id,
                    "videoId": video_id,
                },
            }

    def complete_video_like(self, connection: Connection, claim: dict) -> bool:
        row = connection.execute(
            """
            UPDATE "YouTubeVideoLike"
            SET "status" = 'LIKED', "likedAt" = CURRENT_TIMESTAMP,
                "ownerId" = NULL, "lockedUntil" = NULL, "lastErrorCode" = NULL,
                "updatedAt" = CURRENT_TIMESTAMP
            WHERE "id" = %s AND "status" = 'PENDING'
              AND "ownerId" = %s AND "leaseVersion" = %s
            RETURNING "id"
            """,
            (claim["id"], claim["ownerId"], claim["leaseVersion"]),
        ).fetchone()
        return bool(row)

    def release_video_like(
        self, connection: Connection, claim: dict | None, error_code: str | None = None
    ) -> bool:
        if not claim:
            return False
        row = connection.execute(
            """
            UPDATE "YouTubeVideoLike"
            SET "ownerId" = NULL, "lockedUntil" = NULL, "lastErrorCode" = %s,
                "updatedAt" = CURRENT_TIMESTAMP
            WHERE "id" = %s AND "status" = 'PENDING'
              AND "ownerId" = %s AND "leaseVersion" = %s
            RETURNING "id"
            """,
            (error_code, claim["id"], claim["ownerId"], claim["leaseVersion"]),
        ).fetchone()
        return bool(row)

    def finish_video_track(
        self,
        job: dict,
        worker_id: str,
        lease_ms: int,
        track_id: str,
        claim: dict,
        status: str,
    ) -> None:
        with self.fenced(job, worker_id, ["RUNNING"], lease_ms) as connection:
            completed = self.complete_video_like(connection, claim)
            if not completed:
                current = connection.execute(
                    'SELECT "status"::text AS status FROM "YouTubeVideoLike" WHERE "id" = %s',
                    (claim["id"],),
                ).fetchone()
                if not current or current["status"] != "LIKED":
                    raise LeaseLostError()
            connection.execute(
                """
                UPDATE "MigrationTrack"
                SET "status" = %s::"MigrationTrackStatus", "errorCode" = NULL,
                    "errorMessage" = NULL, "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = %s AND "migrationId" = %s AND "status" IN ('READY', 'LIKING')
                """,
                (status, track_id, job["id"]),
            )

    def mark_duplicate_already_liked(
        self, job: dict, worker_id: str, lease_ms: int, track_id: str
    ) -> None:
        with self.fenced(job, worker_id, ["RUNNING"], lease_ms) as connection:
            connection.execute(
                """
                UPDATE "MigrationTrack"
                SET "status" = 'ALREADY_LIKED', "errorCode" = NULL, "errorMessage" = NULL,
                    "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = %s AND "migrationId" = %s AND "status" = 'LIKING'
                """,
                (track_id, job["id"]),
            )

    def fail_like_track(
        self,
        job: dict,
        worker_id: str,
        lease_ms: int,
        track_id: str,
        claim: dict | None,
        error_code: str,
    ) -> None:
        with self.fenced(job, worker_id, ["RUNNING"], lease_ms) as connection:
            self.release_video_like(connection, claim, error_code)
            connection.execute(
                """
                UPDATE "MigrationTrack"
                SET "status" = 'FAILED', "retryCount" = "retryCount" + 1,
                    "errorCode" = %s, "errorMessage" = 'Could not migrate this track.',
                    "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = %s AND "migrationId" = %s AND "status" IN ('READY', 'LIKING')
                """,
                (error_code, track_id, job["id"]),
            )

    def refresh_liking_counts(self, job: dict, worker_id: str, lease_ms: int) -> None:
        with self.fenced(job, worker_id, ["RUNNING"], lease_ms) as connection:
            self.refresh_counts(connection, job["id"], "LIKING")

    def complete_if_finished(self, job: dict, worker_id: str, lease_ms: int) -> bool:
        with self.fenced(job, worker_id, ["RUNNING"], lease_ms) as connection:
            counters = persisted_counter_data(
                self._counter_data(connection, job["id"], "LIKING")
            )
            remaining = connection.execute(
                """
                SELECT COUNT(*)::int AS count FROM "MigrationTrack"
                WHERE "migrationId" = %s AND "status" IN ('PENDING', 'SCANNING', 'READY', 'LIKING')
                """,
                (job["id"],),
            ).fetchone()["count"]
            fields = dict(counters)
            if remaining == 0:
                fields.update(
                    {
                        "status": "COMPLETED",
                        "completedAt": utcnow(),
                        "currentTrackTitle": None,
                        "currentTrackArtist": None,
                    }
                )
            self.update_migration_row(connection, job["id"], fields)
            return remaining == 0
