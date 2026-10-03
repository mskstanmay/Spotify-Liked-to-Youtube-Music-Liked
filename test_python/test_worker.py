from __future__ import annotations

import logging
import threading
import time
from copy import deepcopy
from types import SimpleNamespace

from musicmove_worker.db import LeaseLostError
from musicmove_worker.providers.http import ProviderError
from musicmove_worker.worker import MigrationWorker, _Heartbeat, public_worker_error


def worker_config(**overrides):
    values = {
        "worker_lease_ms": 60_000,
        "worker_poll_ms": 10,
        "request_delay_ms": 0,
        "max_retries": 3,
        "match_confidence_threshold": 0.85,
        "auto_review_min_score": 0.72,
        "ytmusic_search_limit": 10,
        "provider_timeout_seconds": 30,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class NoopProvider:
    def close(self):
        pass


class FakeMigrationDB:
    def __init__(self, tracks, *, fail_finish_once=False):
        self.tracks = tracks
        self.job = {
            "id": "migration-1",
            "userId": "user-1",
            "phase": "LIKING",
            "status": "QUEUED",
            "leaseVersion": 1,
            "startedAt": None,
        }
        self.claim_available = True
        self.released = False
        self.completed = False
        self.runtime_reports = 0
        self.video_claim = None
        self.fail_finish_once = fail_finish_once
        self.failed_claims = []

    def report_runtime(self, _worker_id):
        self.runtime_reports += 1

    def claim_migration(self, _worker_id, _lease_ms):
        if not self.claim_available:
            return None
        self.claim_available = False
        return deepcopy(self.job)

    def renew_lease(self, job, _worker_id, _lease_ms):
        if job.get("leaseLost"):
            raise LeaseLostError()

    def owns(self, job, _worker_id, statuses):
        return not job.get("leaseLost") and "RUNNING" in statuses

    def release_migration(self, _job, _worker_id):
        self.released = True

    def begin_migration(self, job, _worker_id, _lease_ms):
        job["status"] = "RUNNING"

    def get_youtube_connection(self, _user_id):
        return {"id": "youtube-1"}

    def pending_like_tracks(self, _migration_id):
        return [
            track for track in self.tracks if track["status"] in {"READY", "LIKING"}
        ]

    def update_current_track(self, _job, _worker_id, _lease_ms, _track):
        pass

    def mark_initial_already_liked(self, _job, _worker_id, _lease_ms, track):
        track["status"] = "ALREADY_LIKED"

    def begin_like_track(self, _job, _worker_id, _lease_ms, track_id):
        track = next(track for track in self.tracks if track["id"] == track_id)
        track["status"] = "LIKING"
        return True

    def try_claim_video_like(self, user_id, video_id, owner_id, _locked_until):
        self.video_claim = {
            "id": f"claim-{video_id}",
            "ownerId": owner_id,
            "leaseVersion": 1,
            "userId": user_id,
            "videoId": video_id,
        }
        return {"state": "CLAIMED", "claim": self.video_claim}

    def finish_video_track(self, _job, _worker_id, _lease_ms, track_id, _claim, status):
        if self.fail_finish_once:
            self.fail_finish_once = False
            raise RuntimeError("simulated crash after provider success")
        track = next(track for track in self.tracks if track["id"] == track_id)
        track["status"] = status

    def mark_duplicate_already_liked(self, _job, _worker_id, _lease_ms, track_id):
        next(track for track in self.tracks if track["id"] == track_id)["status"] = (
            "ALREADY_LIKED"
        )

    def fail_like_track(self, _job, _worker_id, _lease_ms, track_id, claim, error_code):
        track = next(track for track in self.tracks if track["id"] == track_id)
        track["status"] = "FAILED"
        track["retryCount"] = track.get("retryCount", 0) + 1
        self.failed_claims.append((claim, error_code))

    def refresh_liking_counts(self, _job, _worker_id, _lease_ms):
        pass

    def complete_if_finished(self, _job, _worker_id, _lease_ms):
        self.completed = not any(
            track["status"] in {"PENDING", "SCANNING", "READY", "LIKING"}
            for track in self.tracks
        )
        return self.completed

    def update_migration(self, _job, _worker_id, _statuses, _lease_ms, fields):
        self.job.update(fields)


class FakeYouTube:
    def __init__(self, *, fail_before_rate=False):
        self.external_likes = set()
        self.rate_calls = 0
        self.fail_before_rate = fail_before_rate

    def close(self):
        pass

    def ratings(self, _connection, video_ids, before_attempt=lambda _attempt: None):
        before_attempt(0)
        return {
            video_id: "like" if video_id in self.external_likes else "none"
            for video_id in video_ids
        }

    def like_video(self, _connection, video_id, before_attempt=lambda _attempt: None):
        before_attempt(0)
        self.rate_calls += 1
        if self.fail_before_rate:
            raise RuntimeError("provider failed before rate")
        self.external_likes.add(video_id)


def track(identifier="track-1", *, video_id="video-1", needs_review=True):
    return {
        "id": identifier,
        "status": "READY",
        "spotifyTitle": "Song",
        "spotifyArtists": ["Artist"],
        "matchedYoutubeVideoId": video_id,
        "needsReview": needs_review,
        "retryCount": 0,
    }


def make_worker(db, youtube):
    return MigrationWorker(
        db,
        worker_config(),
        worker_id="python-test-worker",
        logger=logging.getLogger("test_worker"),
        spotify=NoopProvider(),
        youtube=youtube,
        ytmusic=NoopProvider(),
        sleep=lambda _delay: None,
    )


def test_needs_review_survives_ready_liking_liked_and_completion():
    item = track()
    db = FakeMigrationDB([item])
    youtube = FakeYouTube()
    assert make_worker(db, youtube).run_once() is True
    assert item["status"] == "LIKED"
    assert item["needsReview"] is True
    assert db.completed is True
    assert youtube.rate_calls == 1


def test_duplicate_video_is_rated_once_and_second_track_is_already_liked():
    first = track("track-1", video_id="shared", needs_review=False)
    second = track("track-2", video_id="shared", needs_review=True)
    db = FakeMigrationDB([first, second])
    youtube = FakeYouTube()
    make_worker(db, youtube).run_once()
    assert [first["status"], second["status"]] == ["LIKED", "ALREADY_LIKED"]
    assert second["needsReview"] is True
    assert youtube.rate_calls == 1


def test_crash_before_rate_marks_failed_and_releases_claim():
    item = track()
    db = FakeMigrationDB([item])
    youtube = FakeYouTube(fail_before_rate=True)
    make_worker(db, youtube).run_once()
    assert item["status"] == "FAILED"
    assert item["needsReview"] is True
    assert item["retryCount"] == 1
    assert db.failed_claims[0][0]["videoId"] == "video-1"
    assert youtube.external_likes == set()


def test_crash_after_rate_is_recovered_by_rating_check_without_second_rate():
    item = track()
    db = FakeMigrationDB([item], fail_finish_once=True)
    youtube = FakeYouTube()
    make_worker(db, youtube).run_once()
    assert item["status"] == "FAILED"
    assert "video-1" in youtube.external_likes
    assert youtube.rate_calls == 1

    # The existing Node retry route performs this FAILED -> READY transition.
    item["status"] = "READY"
    db.claim_available = True
    db.completed = False
    make_worker(db, youtube).run_once()
    assert item["status"] == "ALREADY_LIKED"
    assert item["needsReview"] is True
    assert youtube.rate_calls == 1


def test_heartbeat_database_error_fails_closed():
    class BrokenDB(FakeMigrationDB):
        def renew_lease(self, job, _worker_id, _lease_ms):
            raise RuntimeError("database unavailable")

    db = BrokenDB([])
    worker = make_worker(db, FakeYouTube())
    worker.config.worker_lease_ms = 30
    job = {"id": "m", "phase": "LIKING", "leaseLost": False}
    heartbeat = _Heartbeat(worker, job)
    heartbeat.start()
    time.sleep(0.04)
    heartbeat.stop()
    assert job["leaseLost"] is True


def test_start_stops_gracefully_when_signal_handler_calls_stop():
    db = FakeMigrationDB([])
    db.claim_available = False
    worker = make_worker(db, FakeYouTube())
    thread = threading.Thread(target=worker.start)
    thread.start()
    time.sleep(0.03)
    worker.stop()
    thread.join(timeout=1)
    assert not thread.is_alive()
    assert db.runtime_reports >= 1


def test_quota_and_authentication_map_to_pause_states():
    quota = ProviderError(
        "quota", provider="YouTube", code="quotaExceeded", quota_exceeded=True
    )
    auth = ProviderError(
        "auth", provider="YouTube", code="invalid_grant", authentication_required=True
    )
    assert public_worker_error(quota)["status"] == "QUOTA_PAUSED"
    assert public_worker_error(auth)["status"] == "AUTHENTICATION_REQUIRED"
