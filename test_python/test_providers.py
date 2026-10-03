from __future__ import annotations

import threading
import time
from copy import deepcopy
from datetime import timedelta
from types import SimpleNamespace

import httpx
import pytest

from musicmove_worker.crypto import encrypt_secret
from musicmove_worker.db import utcnow
from musicmove_worker.providers.http import ProviderError
from musicmove_worker.providers.spotify import SpotifyProvider
from musicmove_worker.providers.youtube import YouTubeProvider

KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="


def config(**overrides):
    values = {
        "token_encryption_key": KEY,
        "spotify_client_id": "spotify-client",
        "google_client_id": "google-client",
        "google_client_secret": "google-secret",
        "max_retries": 3,
        "provider_timeout_seconds": 30,
        "google_refresh_lease_ms": 35_000,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class TokenDB:
    def __init__(self, spotify=None, youtube=None):
        self.spotify = spotify
        self.youtube = youtube
        self.health = []
        self.saved_spotify = []
        self._lock = threading.Lock()
        self.refresh_owner = None

    def get_spotify_connection_by_id(self, _connection_id):
        return deepcopy(self.spotify)

    def save_spotify_tokens(self, connection_id, data):
        self.saved_spotify.append((connection_id, data))
        self.spotify.update(data)

    def mark_connection_health(self, table, connection_id, status, error_code):
        self.health.append((table, connection_id, status, error_code))

    def get_youtube_connection_by_id(self, _connection_id):
        with self._lock:
            return deepcopy(self.youtube)

    def try_claim_youtube_refresh(self, _connection_id, version, owner, _locked_until):
        with self._lock:
            if version != self.youtube["refreshVersion"] or self.refresh_owner:
                return False
            self.refresh_owner = owner
            self.youtube["refreshOwner"] = owner
            return True

    def save_youtube_refresh(self, _connection_id, version, owner, data):
        with self._lock:
            if self.refresh_owner != owner or self.youtube["refreshVersion"] != version:
                return False
            self.youtube.update(data)
            self.youtube["refreshVersion"] += 1
            self.youtube["refreshOwner"] = None
            self.refresh_owner = None
            return True

    def release_youtube_refresh(self, _connection_id, owner):
        with self._lock:
            if self.refresh_owner == owner:
                self.refresh_owner = None
                self.youtube["refreshOwner"] = None


def spotify_connection():
    return {
        "id": "spotify-1",
        "encryptedAccessToken": encrypt_secret("old-access", KEY),
        "encryptedRefreshToken": encrypt_secret("refresh", KEY),
        "expiresAt": utcnow() + timedelta(hours=1),
        "connectionStatus": "ACTIVE",
        "lastAuthErrorCode": None,
    }


def youtube_connection():
    return {
        "id": "youtube-1",
        "encryptedAccessToken": encrypt_secret("old-google-access", KEY),
        "encryptedRefreshToken": encrypt_secret("google-refresh", KEY),
        "expiresAt": utcnow() + timedelta(hours=1),
        "connectionStatus": "ACTIVE",
        "lastAuthErrorCode": None,
        "refreshVersion": 0,
    }


def test_spotify_refreshes_once_after_401_and_retries_page():
    calls = []

    def handler(request):
        calls.append((request.method, str(request.url)))
        if request.url.host == "accounts.spotify.com":
            return httpx.Response(
                200, json={"access_token": "fresh-access", "expires_in": 3600}
            )
        api_calls = [call for call in calls if "api.spotify.com" in call[1]]
        if len(api_calls) == 1:
            return httpx.Response(401, json={"error": {"status": 401}})
        return httpx.Response(
            200,
            json={
                "total": 1,
                "items": [
                    {
                        "track": {
                            "id": "s1",
                            "name": "Song",
                            "artists": [{"name": "Artist"}],
                            "album": {"name": "Album"},
                            "duration_ms": 1000,
                            "external_urls": {"spotify": "https://spotify.test/s1"},
                        }
                    }
                ],
            },
        )

    connection = spotify_connection()
    db = TokenDB(spotify=connection)
    provider = SpotifyProvider(
        db,
        config(),
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        sleep=lambda _delay: None,
    )
    result = provider.fetch_liked_tracks(connection)
    assert [track["spotifyTrackId"] for track in result["tracks"]] == ["s1"]
    assert len(db.saved_spotify) == 1
    assert [host for _method, host in calls if "api.spotify.com" in host].__len__() == 2


def test_spotify_429_uses_bounded_retry_after_and_retries():
    calls = 0
    sleeps = []

    def handler(_request):
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(
                429,
                headers={"Retry-After": "0.25"},
                json={"error": "rateLimitExceeded"},
            )
        return httpx.Response(200, json={"total": 0, "items": []})

    connection = spotify_connection()
    provider = SpotifyProvider(
        TokenDB(spotify=connection),
        config(),
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        sleep=sleeps.append,
    )
    assert provider.fetch_liked_tracks(connection)["tracks"] == []
    assert calls == 2
    assert sleeps[0] == 0.25


def test_youtube_transient_rate_limit_retries_but_daily_quota_does_not():
    connection = youtube_connection()
    transient_calls = 0

    def transient_handler(_request):
        nonlocal transient_calls
        transient_calls += 1
        if transient_calls == 1:
            return httpx.Response(
                403, json={"error": {"errors": [{"reason": "rateLimitExceeded"}]}}
            )
        return httpx.Response(200, json={"items": [{"videoId": "v", "rating": "none"}]})

    provider = YouTubeProvider(
        TokenDB(youtube=deepcopy(connection)),
        config(),
        client=httpx.Client(transport=httpx.MockTransport(transient_handler)),
        sleep=lambda _delay: None,
    )
    assert provider.ratings(connection, ["v"]) == {"v": "none"}
    assert transient_calls == 2

    quota_calls = 0

    def quota_handler(_request):
        nonlocal quota_calls
        quota_calls += 1
        return httpx.Response(
            403, json={"error": {"errors": [{"reason": "quotaExceeded"}]}}
        )

    quota_provider = YouTubeProvider(
        TokenDB(youtube=deepcopy(connection)),
        config(),
        client=httpx.Client(transport=httpx.MockTransport(quota_handler)),
        sleep=lambda _delay: None,
    )
    with pytest.raises(ProviderError) as caught:
        quota_provider.like_video(connection, "v")
    assert caught.value.quota_exceeded is True
    assert caught.value.retryable is False
    assert quota_calls == 1


def test_google_401_forces_one_fenced_refresh_then_retries():
    connection = youtube_connection()
    db = TokenDB(youtube=deepcopy(connection))
    calls = []

    def handler(request):
        calls.append(str(request.url))
        if request.url.host == "oauth2.googleapis.com":
            return httpx.Response(
                200, json={"access_token": "fresh-google", "expires_in": 3600}
            )
        youtube_calls = [url for url in calls if "youtube" in url]
        if len(youtube_calls) == 1:
            return httpx.Response(401, json={"error": {"status": "UNAUTHENTICATED"}})
        return httpx.Response(200, json={"items": [{"videoId": "v", "rating": "like"}]})

    provider = YouTubeProvider(
        db,
        config(),
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        sleep=lambda _delay: None,
    )
    assert provider.ratings(connection, ["v"]) == {"v": "like"}
    assert db.youtube["refreshVersion"] == 1
    assert len([url for url in calls if "oauth2.googleapis.com" in url]) == 1


def test_concurrent_google_refresh_uses_one_token_request():
    base = youtube_connection()
    base["expiresAt"] = utcnow() - timedelta(seconds=1)
    db = TokenDB(youtube=deepcopy(base))
    token_calls = 0
    token_lock = threading.Lock()

    def handler(_request):
        nonlocal token_calls
        with token_lock:
            token_calls += 1
        time.sleep(0.02)
        return httpx.Response(
            200, json={"access_token": "shared-fresh", "expires_in": 3600}
        )

    provider = YouTubeProvider(
        db,
        config(),
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        sleep=lambda delay: time.sleep(min(delay, 0.002)),
    )
    connections = [deepcopy(base), deepcopy(base)]
    outputs = []
    threads = [
        threading.Thread(
            target=lambda item=item: outputs.append(provider.valid_access_token(item))
        )
        for item in connections
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert outputs == ["shared-fresh", "shared-fresh"]
    assert token_calls == 1
