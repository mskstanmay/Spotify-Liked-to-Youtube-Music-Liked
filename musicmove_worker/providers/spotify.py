from __future__ import annotations

import time
from collections.abc import Callable
from datetime import timedelta

import httpx

from ..crypto import decrypt_secret, encrypt_secret
from ..db import Database, utcnow
from ..retry import with_retries
from .http import (
    ProviderError,
    ensure_connection_usable,
    json_response,
    provider_request,
)

SPOTIFY_SCOPE = "user-library-read user-read-private"


class SpotifyProvider:
    def __init__(
        self,
        db: Database,
        config,
        *,
        client: httpx.Client | None = None,
        sleep=time.sleep,
    ) -> None:
        self.db = db
        self.config = config
        self.client = client or httpx.Client(timeout=config.provider_timeout_seconds)
        self._owns_client = client is None
        self.sleep = sleep

    def close(self) -> None:
        if self._owns_client:
            self.client.close()

    def _token_request(self, params: dict) -> dict:
        response = provider_request(
            self.client,
            "POST",
            "https://accounts.spotify.com/api/token",
            "Spotify",
            data={"client_id": self.config.spotify_client_id, **params},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        return json_response(response, "Spotify")

    def _token_record(
        self, token: dict, previous_refresh_token: str | None = None
    ) -> dict:
        return {
            "encryptedAccessToken": encrypt_secret(
                token.get("access_token"), self.config.token_encryption_key
            ),
            "encryptedRefreshToken": encrypt_secret(
                token.get("refresh_token") or previous_refresh_token,
                self.config.token_encryption_key,
            ),
            "expiresAt": utcnow() + timedelta(seconds=token.get("expires_in") or 3_600),
            "scopes": [
                item
                for item in str(token.get("scope") or SPOTIFY_SCOPE).split(" ")
                if item
            ],
        }

    def _mark_health(
        self, connection: dict, status: str, error_code: str | None
    ) -> None:
        self.db.mark_connection_health(
            "SpotifyConnection", connection["id"], status, error_code
        )
        connection.update(
            {
                "connectionStatus": status,
                "lastAuthErrorCode": error_code,
                "authInvalidAt": None if status == "ACTIVE" else utcnow(),
            }
        )

    def valid_access_token(self, connection: dict | None) -> str:
        if not connection:
            raise ProviderError(
                "Spotify needs to be connected again.",
                provider="Spotify",
                authentication_required=True,
            )
        ensure_connection_usable(connection, "Spotify")
        expires_at = connection.get("expiresAt")
        if expires_at and expires_at > utcnow() + timedelta(seconds=60):
            return (
                decrypt_secret(
                    connection["encryptedAccessToken"], self.config.token_encryption_key
                )
                or ""
            )
        refresh_token = decrypt_secret(
            connection.get("encryptedRefreshToken"), self.config.token_encryption_key
        )
        if not refresh_token:
            self._mark_health(connection, "RECONNECT_REQUIRED", "REFRESH_TOKEN_MISSING")
            raise ProviderError(
                "Spotify needs to be connected again.",
                provider="Spotify",
                code="REFRESH_TOKEN_MISSING",
                authentication_required=True,
            )
        try:
            token = self._token_request(
                {"grant_type": "refresh_token", "refresh_token": refresh_token}
            )
        except ProviderError as error:
            if error.authentication_required:
                self._mark_health(connection, "AUTHENTICATION_INVALID", error.code)
            raise
        data = self._token_record(token, refresh_token)
        self.db.save_spotify_tokens(connection["id"], data)
        connection.update(
            data,
            connectionStatus="ACTIVE",
            lastAuthErrorCode=None,
            authInvalidAt=None,
        )
        return token["access_token"]

    def _spotify_get(self, path: str, access_token: str) -> dict:
        response = provider_request(
            self.client,
            "GET",
            f"https://api.spotify.com/v1{path}",
            "Spotify",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        return json_response(response, "Spotify")

    @staticmethod
    def _map_track(item: dict) -> dict:
        track = item.get("track") or {}
        return {
            "spotifyTrackId": track.get("id"),
            "title": track.get("name"),
            "artists": [
                artist.get("name")
                for artist in track.get("artists", [])
                if artist.get("name")
            ],
            "album": (track.get("album") or {}).get("name") or "",
            "durationMs": track.get("duration_ms") or 0,
            "spotifyUrl": (track.get("external_urls") or {}).get("spotify") or "",
        }

    def fetch_liked_tracks(
        self,
        connection: dict | None,
        *,
        on_progress: Callable[
            [int, int, int], None
        ] = lambda _count, _visible, _source: None,
        should_continue: Callable[[], None] = lambda: None,
        track_limit: int | None = None,
        on_retry: Callable[
            [Exception, int, int], None
        ] = lambda _error, _number, _delay: None,
    ) -> dict:
        access_token = self.valid_access_token(connection)
        assert connection is not None
        offset = 0
        total: int | None = None
        tracks: list[dict] = []
        while (total is None or offset < total) and (
            not track_limit or len(tracks) < track_limit
        ):
            page_limit = min(
                50, max(1, track_limit - len(tracks)) if track_limit else 50
            )

            def request(
                _attempt: int, page_limit: int = page_limit, offset: int = offset
            ) -> dict:
                nonlocal access_token
                should_continue()
                try:
                    return self._spotify_get(
                        f"/me/tracks?limit={page_limit}&offset={offset}", access_token
                    )
                except ProviderError as error:
                    if error.status != 401:
                        raise
                    fresh = self.db.get_spotify_connection_by_id(connection["id"])
                    if not fresh:
                        raise
                    fresh["expiresAt"] = utcnow() - timedelta(days=1)
                    access_token = self.valid_access_token(fresh)
                    try:
                        return self._spotify_get(
                            f"/me/tracks?limit={page_limit}&offset={offset}",
                            access_token,
                        )
                    except ProviderError as retry_error:
                        if retry_error.status == 401:
                            self._mark_health(
                                fresh, "AUTHENTICATION_INVALID", retry_error.code
                            )
                        raise

            page = with_retries(
                request,
                retries=self.config.max_retries,
                base_delay_ms=800,
                should_retry=lambda error: bool(getattr(error, "retryable", False)),
                on_retry=on_retry,
                sleep=self.sleep,
            )
            total = page.get("total") or 0
            items = page.get("items") or []
            mapped = [self._map_track(item) for item in items]
            mapped = [
                track for track in mapped if track["spotifyTrackId"] and track["title"]
            ]
            remaining = max(0, track_limit - len(tracks)) if track_limit else None
            tracks.extend(mapped[:remaining] if remaining is not None else mapped)
            offset += len(items)
            visible_total = min(total, track_limit) if track_limit else total
            on_progress(len(tracks), visible_total, total)
            if not items:
                break
            self.sleep(0.025)
        return {"tracks": tracks, "sourceTotal": total or 0}
