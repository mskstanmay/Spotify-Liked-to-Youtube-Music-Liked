from __future__ import annotations

import logging
import os
import threading
import time
from datetime import timedelta

from .db import CLAIMABLE_STATUSES, Database, LeaseLostError, utcnow
from .logging import log_operation
from .matching import match_track, scan_result_data
from .providers.spotify import SpotifyProvider
from .providers.youtube import YouTubeProvider
from .providers.ytmusic import YouTubeMusicProvider
from .retry import with_retries


def public_worker_error(error: Exception) -> dict:
    if getattr(error, "authentication_required", False):
        return {
            "status": "AUTHENTICATION_REQUIRED",
            "code": "AUTHENTICATION_REQUIRED",
            "message": f"{getattr(error, 'provider', None) or 'A provider'} needs to be connected again.",
        }
    if getattr(error, "quota_exceeded", False):
        return {
            "status": "QUOTA_PAUSED",
            "code": "YOUTUBE_QUOTA_EXCEEDED",
            "message": "YouTube API quota was reached. Your progress is safe; resume after quota becomes available.",
        }
    return {
        "status": "FAILED",
        "code": getattr(error, "code", None) or "MIGRATION_FAILED",
        "message": (
            "A provider is temporarily unavailable. Your progress is safe."
            if getattr(error, "retryable", False)
            else "The migration could not continue. Your progress is safe."
        ),
    }


class _Heartbeat:
    def __init__(self, worker: MigrationWorker, job: dict) -> None:
        self.worker = worker
        self.job = job
        self.stopping = threading.Event()
        self.thread = threading.Thread(
            target=self._run,
            name=f"heartbeat-{worker.id}",
            daemon=True,
        )

    def start(self) -> None:
        self.thread.start()

    def _run(self) -> None:
        interval = max(0.01, self.worker.config.worker_lease_ms / 3 / 1_000)
        while not self.stopping.wait(interval):
            try:
                self.worker.heartbeat(self.job)
            except Exception as error:
                # Fail closed: a DB outage is indistinguishable from losing the
                # lease, so no new provider operation may begin.
                self.job["leaseLost"] = True
                if not isinstance(error, LeaseLostError):
                    self.worker.operation(
                        "error",
                        self.job,
                        operation="heartbeat",
                        provider="database",
                        result="failed",
                        reason=getattr(error, "code", None) or "DATABASE_ERROR",
                    )
                break

    def stop(self) -> None:
        self.stopping.set()
        self.thread.join()


class MigrationWorker:
    def __init__(
        self,
        db: Database,
        config,
        *,
        worker_id: str | None = None,
        logger: logging.Logger | None = None,
        spotify: SpotifyProvider | None = None,
        youtube: YouTubeProvider | None = None,
        ytmusic: YouTubeMusicProvider | None = None,
        sleep=time.sleep,
    ) -> None:
        self.db = db
        self.config = config
        self.id = worker_id or f"worker-python-{os.getpid()}-{os.urandom(4).hex()}"
        self.logger = logger or logging.getLogger("musicmove_worker")
        self.spotify = spotify or SpotifyProvider(db, config)
        self.youtube = youtube or YouTubeProvider(db, config)
        self.ytmusic = ytmusic or YouTubeMusicProvider(
            limit=config.ytmusic_search_limit,
            timeout_seconds=config.provider_timeout_seconds,
        )
        self.sleep = sleep
        self.stopped = threading.Event()

    def close(self) -> None:
        self.spotify.close()
        self.youtube.close()

    def operation(self, level: str, job: dict | None, **fields) -> None:
        log_operation(
            self.logger,
            level,
            {
                "migrationId": job.get("id") if job else None,
                "phase": job.get("phase") if job else None,
                "workerId": self.id,
                **fields,
            },
        )

    def report_runtime(self) -> None:
        self.db.report_runtime(self.id)

    def claim(self) -> dict | None:
        job = self.db.claim_migration(self.id, self.config.worker_lease_ms)
        if job:
            job["leaseLost"] = False
            job["videoClaim"] = None
            self.operation(
                "info", job, operation="claim", provider="database", result="claimed"
            )
        return job

    def heartbeat(self, job: dict) -> bool:
        self.db.renew_lease(job, self.id, self.config.worker_lease_ms)
        return True

    def owns(self, job: dict, statuses: list[str]) -> bool:
        return self.db.owns(job, self.id, statuses)

    def release(self, job: dict) -> None:
        self.db.release_migration(job, self.id)

    def acquire_video_like(self, job: dict, user_id: str, video_id: str) -> dict:
        owner_id = f"{self.id}:{job['leaseVersion']}"
        while self.owns(job, ["RUNNING"]):
            result = self.db.try_claim_video_like(
                user_id,
                video_id,
                owner_id,
                utcnow() + timedelta(milliseconds=self.config.worker_lease_ms),
            )
            if result["state"] == "LIKED":
                return result
            if result["state"] == "CLAIMED":
                job["videoClaim"] = result["claim"]
                return result
            self.sleep(0.1)
        raise LeaseLostError()

    def scan(self, job: dict) -> None:
        connection = self.db.get_spotify_connection(job["userId"])
        track_count = self.db.migration_track_count(job["id"])
        if not track_count:
            started = time.monotonic()

            def on_progress(count: int, visible_total: int, _source_total: int) -> None:
                self.db.update_migration(
                    job,
                    self.id,
                    ["SCANNING"],
                    self.config.worker_lease_ms,
                    {
                        "totalTracks": visible_total or count,
                        "processedTracks": 0,
                        "currentTrackTitle": "Fetching your Spotify library",
                        "currentTrackArtist": f"{count} of {visible_total or '?'}",
                    },
                )

            def should_continue() -> None:
                if job.get("leaseLost"):
                    raise LeaseLostError()

            def on_retry(error: Exception, retry_number: int, _delay: int) -> None:
                self.operation(
                    "warning",
                    job,
                    operation="fetch_liked_tracks",
                    provider="spotify",
                    retryNumber=retry_number,
                    result="retry",
                    reason=getattr(error, "code", None) or "TRANSIENT_ERROR",
                )

            fetched = self.spotify.fetch_liked_tracks(
                connection,
                on_progress=on_progress,
                should_continue=should_continue,
                track_limit=job.get("trackLimit"),
                on_retry=on_retry,
            )
            self.operation(
                "info",
                job,
                operation="fetch_liked_tracks",
                provider="spotify",
                durationMs=int((time.monotonic() - started) * 1_000),
                result="success",
                trackCount=len(fetched["tracks"]),
            )
            self.db.finalize_spotify_fetch(
                job,
                self.id,
                self.config.worker_lease_ms,
                fetched["tracks"],
                fetched["sourceTotal"],
            )

        while self.owns(job, ["SCANNING"]):
            track = self.db.next_scan_track(job["id"])
            if not track:
                break
            if not self.db.begin_scan_track(
                job, self.id, self.config.worker_lease_ms, track
            ):
                continue
            try:
                started = time.monotonic()

                def search(_attempt: int, current_track: dict = track) -> list[dict]:
                    if job.get("leaseLost"):
                        raise LeaseLostError()
                    return self.ytmusic.search_track(
                        {
                            "title": current_track["spotifyTitle"],
                            "artists": current_track["spotifyArtists"],
                        }
                    )

                def search_retry(
                    error: Exception,
                    retry_number: int,
                    _delay: int,
                    current_track: dict = track,
                ) -> None:
                    self.operation(
                        "warning",
                        job,
                        trackId=current_track["id"],
                        operation="search",
                        provider="youtube_music",
                        retryNumber=retry_number,
                        result="retry",
                        reason=getattr(error, "code", None) or "TRANSIENT_ERROR",
                    )

                candidates = with_retries(
                    search,
                    retries=self.config.max_retries,
                    base_delay_ms=700,
                    should_retry=lambda _error: not job.get("leaseLost", False),
                    on_retry=search_retry,
                    sleep=self.sleep,
                )
                result = match_track(
                    {
                        "title": track["spotifyTitle"],
                        "artists": track["spotifyArtists"],
                        "album": track.get("spotifyAlbum"),
                        "durationMs": track.get("spotifyDurationMs"),
                    },
                    candidates,
                    threshold=self.config.match_confidence_threshold,
                )
                result_data = scan_result_data(
                    result, self.config.auto_review_min_score
                )
                self.db.save_scan_result(
                    job,
                    self.id,
                    self.config.worker_lease_ms,
                    track,
                    result_data,
                    result["candidates"],
                )
                operation_result = (
                    "not_found"
                    if result_data["status"] == "NOT_FOUND"
                    else "review"
                    if result_data["status"] == "REVIEW"
                    else "ready_review"
                    if result_data.get("needsReview")
                    else "ready"
                )
                self.operation(
                    "info",
                    job,
                    trackId=track["id"],
                    operation="search",
                    provider="youtube_music",
                    durationMs=int((time.monotonic() - started) * 1_000),
                    result=operation_result,
                )
            except LeaseLostError:
                raise
            except Exception as error:
                self.operation(
                    "error",
                    job,
                    trackId=track["id"],
                    operation="search",
                    provider="youtube_music",
                    result="failed",
                    reason=getattr(error, "code", None) or "SEARCH_FAILED",
                )
                self.db.fail_scan_track(
                    job, self.id, self.config.worker_lease_ms, track["id"]
                )
            if self.config.request_delay_ms:
                self.sleep(self.config.request_delay_ms / 1_000)
        self.db.finish_scanning(job, self.id, self.config.worker_lease_ms)

    def migrate(self, job: dict) -> None:
        self.db.begin_migration(job, self.id, self.config.worker_lease_ms)
        connection = self.db.get_youtube_connection(job["userId"])
        pending = self.db.pending_like_tracks(job["id"])
        ratings_started = time.monotonic()

        def ratings_attempt(retry_number: int = 0) -> None:
            if job.get("leaseLost"):
                raise LeaseLostError()
            if retry_number > 0:
                self.operation(
                    "warning",
                    job,
                    operation="get_ratings",
                    provider="youtube",
                    retryNumber=retry_number,
                    result="retry",
                )

        rating_map = self.youtube.ratings(
            connection,
            [
                track["matchedYoutubeVideoId"]
                for track in pending
                if track.get("matchedYoutubeVideoId")
            ],
            ratings_attempt,
        )
        self.operation(
            "info",
            job,
            operation="get_ratings",
            provider="youtube",
            durationMs=int((time.monotonic() - ratings_started) * 1_000),
            result="success",
            trackCount=len(pending),
        )
        self.heartbeat(job)

        for track in pending:
            if not self.owns(job, ["RUNNING"]):
                raise LeaseLostError()
            self.db.update_current_track(
                job, self.id, self.config.worker_lease_ms, track
            )
            try:
                video_id = track["matchedYoutubeVideoId"]
                if rating_map.get(video_id) == "like":
                    self.db.mark_initial_already_liked(
                        job, self.id, self.config.worker_lease_ms, track
                    )
                    self.operation(
                        "info",
                        job,
                        trackId=track["id"],
                        videoId=video_id,
                        operation="videos.rate",
                        provider="youtube",
                        result="already_liked",
                    )
                else:
                    current_connection = self.db.get_youtube_connection(job["userId"])
                    began = self.db.begin_like_track(
                        job, self.id, self.config.worker_lease_ms, track["id"]
                    )
                    if not began:
                        continue
                    coordinated = self.acquire_video_like(job, job["userId"], video_id)
                    if coordinated["state"] == "LIKED":
                        self.db.mark_duplicate_already_liked(
                            job, self.id, self.config.worker_lease_ms, track["id"]
                        )
                        self.operation(
                            "info",
                            job,
                            trackId=track["id"],
                            videoId=video_id,
                            operation="videos.rate",
                            provider="youtube",
                            result="duplicate_suppressed",
                        )
                    else:
                        verify_started = time.monotonic()

                        def verify_attempt(
                            retry_number: int = 0, current_track: dict = track
                        ) -> None:
                            self.heartbeat(job)
                            if retry_number > 0:
                                self.operation(
                                    "warning",
                                    job,
                                    trackId=current_track["id"],
                                    operation="get_rating",
                                    provider="youtube",
                                    retryNumber=retry_number,
                                    result="retry",
                                )

                        current_rating = self.youtube.ratings(
                            current_connection, [video_id], verify_attempt
                        )
                        self.operation(
                            "info",
                            job,
                            trackId=track["id"],
                            operation="get_rating",
                            provider="youtube",
                            durationMs=int((time.monotonic() - verify_started) * 1_000),
                            result="success",
                        )
                        claim = job["videoClaim"]
                        if current_rating.get(video_id) == "like":
                            job["videoClaim"] = None
                            try:
                                self.db.finish_video_track(
                                    job,
                                    self.id,
                                    self.config.worker_lease_ms,
                                    track["id"],
                                    claim,
                                    "ALREADY_LIKED",
                                )
                            except Exception:
                                job["videoClaim"] = claim
                                raise
                            self.operation(
                                "info",
                                job,
                                trackId=track["id"],
                                videoId=video_id,
                                operation="videos.rate",
                                provider="youtube",
                                result="recovered_already_liked",
                            )
                        else:
                            like_started = time.monotonic()

                            def like_attempt(
                                retry_number: int = 0, current_track: dict = track
                            ) -> None:
                                self.heartbeat(job)
                                if retry_number > 0:
                                    self.operation(
                                        "warning",
                                        job,
                                        trackId=current_track["id"],
                                        operation="videos.rate",
                                        provider="youtube",
                                        retryNumber=retry_number,
                                        result="retry",
                                    )

                            self.youtube.like_video(
                                current_connection, video_id, like_attempt
                            )
                            claim = job["videoClaim"]
                            job["videoClaim"] = None
                            try:
                                self.db.finish_video_track(
                                    job,
                                    self.id,
                                    self.config.worker_lease_ms,
                                    track["id"],
                                    claim,
                                    "LIKED",
                                )
                            except Exception:
                                job["videoClaim"] = claim
                                raise
                            self.operation(
                                "info",
                                job,
                                trackId=track["id"],
                                videoId=video_id,
                                operation="videos.rate",
                                provider="youtube",
                                durationMs=int(
                                    (time.monotonic() - like_started) * 1_000
                                ),
                                result="liked",
                            )
                    rating_map[video_id] = "like"
            except Exception as error:
                if (
                    isinstance(error, LeaseLostError)
                    or getattr(error, "authentication_required", False)
                    or getattr(error, "quota_exceeded", False)
                ):
                    raise
                failed_claim = job.get("videoClaim")
                job["videoClaim"] = None
                self.db.fail_like_track(
                    job,
                    self.id,
                    self.config.worker_lease_ms,
                    track["id"],
                    failed_claim,
                    getattr(error, "code", None) or "LIKE_FAILED",
                )
                self.operation(
                    "error",
                    job,
                    trackId=track["id"],
                    operation="videos.rate",
                    provider="youtube",
                    result="failed",
                    reason=getattr(error, "code", None) or "LIKE_FAILED",
                )
            self.db.refresh_liking_counts(job, self.id, self.config.worker_lease_ms)
            if self.config.request_delay_ms:
                self.sleep(self.config.request_delay_ms / 1_000)
        if self.db.complete_if_finished(job, self.id, self.config.worker_lease_ms):
            self.operation(
                "info",
                job,
                operation="migration",
                provider="worker",
                result="completed",
            )

    def run_once(self) -> bool:
        job = self.claim()
        if not job:
            return False
        heartbeat = _Heartbeat(self, job)
        heartbeat.start()
        try:
            if job["phase"] == "SCANNING":
                self.scan(job)
            else:
                self.migrate(job)
        except LeaseLostError:
            pass
        except Exception as error:
            safe = public_worker_error(error)
            try:
                self.db.update_migration(
                    job,
                    self.id,
                    list(CLAIMABLE_STATUSES),
                    self.config.worker_lease_ms,
                    {
                        "status": safe["status"],
                        "lastErrorCode": safe["code"],
                        "lastErrorMessage": safe["message"],
                    },
                )
            except LeaseLostError:
                pass
            self.operation(
                "error",
                job,
                operation="migration",
                provider=getattr(error, "provider", None) or "worker",
                result=safe["status"].lower(),
                reason=safe["code"],
            )
        finally:
            heartbeat.stop()
            try:
                self.release(job)
            except Exception:
                pass
        return True

    def start(self) -> None:
        self.stopped.clear()
        self.report_runtime()
        while not self.stopped.is_set():
            try:
                self.report_runtime()
                worked = self.run_once()
            except Exception as error:
                self.operation(
                    "error",
                    None,
                    operation="worker_loop",
                    provider="worker",
                    result="failed",
                    reason=getattr(error, "code", None) or "WORKER_ERROR",
                )
                worked = False
            if not worked:
                self.stopped.wait(self.config.worker_poll_ms / 1_000)

    def stop(self) -> None:
        self.stopped.set()
