from __future__ import annotations

import time
import uuid
from collections.abc import Callable
from datetime import timedelta
from urllib.parse import quote

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

GOOGLE_SCOPES = [
    "openid",
    "profile",
    "https://www.googleapis.com/auth/youtube.force-ssl",
]


class YouTubeProvider:
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

    def _mark_health(
        self, connection: dict, status: str, error_code: str | None
    ) -> None:
        self.db.mark_connection_health(
            "YouTubeConnection", connection["id"], status, error_code
        )
        connection.update(
            {
                "connectionStatus": status,
                "lastAuthErrorCode": error_code,
                "authInvalidAt": None if status == "ACTIVE" else utcnow(),
            }
        )

    def _token_request(self, params: dict) -> dict:
        response = provider_request(
            self.client,
            "POST",
            "https://oauth2.googleapis.com/token",
            "Google",
            data={
                "client_id": self.config.google_client_id,
                "client_secret": self.config.google_client_secret,
                **params,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        return json_response(response, "Google")

    def _token_record(self, token: dict, previous_refresh_token: str | None) -> dict:
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
                for item in str(token.get("scope") or " ".join(GOOGLE_SCOPES)).split(
                    " "
                )
                if item
            ],
        }

    def refresh_access_token(self, connection: dict) -> str:
        ensure_connection_usable(connection, "YouTube")
        original_version = connection.get("refreshVersion") or 0
        owner = f"refresh-{uuid.uuid4()}"
        lease_ms = self.config.google_refresh_lease_ms
        deadline = time.monotonic() + lease_ms * 2 / 1_000
        while time.monotonic() < deadline:
            fresh = self.db.get_youtube_connection_by_id(connection["id"])
            if not fresh:
                raise ProviderError(
                    "YouTube Music needs to be connected again.",
                    provider="YouTube",
                    authentication_required=True,
                )
            if (fresh.get("refreshVersion") or 0) > original_version:
                connection.update(fresh)
                return (
                    decrypt_secret(
                        fresh["encryptedAccessToken"], self.config.token_encryption_key
                    )
                    or ""
                )
            version = fresh.get("refreshVersion") or 0
            claimed = self.db.try_claim_youtube_refresh(
                fresh["id"], version, owner, utcnow() + timedelta(milliseconds=lease_ms)
            )
            if not claimed:
                self.sleep(0.05)
                continue
            try:
                refresh_token = decrypt_secret(
                    fresh.get("encryptedRefreshToken"), self.config.token_encryption_key
                )
                if not refresh_token:
                    self._mark_health(
                        fresh, "RECONNECT_REQUIRED", "REFRESH_TOKEN_MISSING"
                    )
                    raise ProviderError(
                        "YouTube Music needs to be connected again.",
                        provider="YouTube",
                        code="REFRESH_TOKEN_MISSING",
                        authentication_required=True,
                    )
                token = self._token_request(
                    {"grant_type": "refresh_token", "refresh_token": refresh_token}
                )
                data = self._token_record(token, refresh_token)
                if not self.db.save_youtube_refresh(fresh["id"], version, owner, data):
                    raise ProviderError(
                        "YouTube token refresh ownership was lost.",
                        provider="YouTube",
                        code="TOKEN_REFRESH_FENCE_LOST",
                        retryable=True,
                    )
                connection.update(
                    data,
                    refreshVersion=version + 1,
                    refreshOwner=None,
                    refreshLockedUntil=None,
                    connectionStatus="ACTIVE",
                    lastAuthErrorCode=None,
                    authInvalidAt=None,
                )
                return token["access_token"]
            except Exception as error:
                try:
                    self.db.release_youtube_refresh(fresh["id"], owner)
                except Exception:
                    pass
                if (
                    getattr(error, "authentication_required", False)
                    and getattr(error, "code", None) != "REFRESH_TOKEN_MISSING"
                ):
                    try:
                        self._mark_health(
                            fresh,
                            "AUTHENTICATION_INVALID",
                            getattr(error, "code", None),
                        )
                    except Exception:
                        pass
                raise
        raise ProviderError(
            "A concurrent YouTube token refresh did not finish in time.",
            provider="YouTube",
            code="TOKEN_REFRESH_TIMEOUT",
            retryable=True,
        )

    def valid_access_token(
        self, connection: dict | None, *, force_refresh: bool = False
    ) -> str:
        if not connection:
            raise ProviderError(
                "YouTube Music needs to be connected again.",
                provider="YouTube",
                authentication_required=True,
            )
        ensure_connection_usable(connection, "YouTube")
        expires_at = connection.get("expiresAt")
        if (
            not force_refresh
            and expires_at
            and expires_at > utcnow() + timedelta(seconds=60)
        ):
            return (
                decrypt_secret(
                    connection["encryptedAccessToken"], self.config.token_encryption_key
                )
                or ""
            )
        return self.refresh_access_token(connection)

    def _youtube_request(
        self, path: str, access_token: str, method: str = "GET"
    ) -> dict:
        response = provider_request(
            self.client,
            method,
            f"https://www.googleapis.com/youtube/v3{path}",
            "YouTube",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        return {} if response.status_code == 204 else json_response(response, "YouTube")

    def _authenticated_request(
        self,
        connection: dict | None,
        path: str,
        *,
        method: str = "GET",
        before_attempt: Callable[[int], None] = lambda _attempt: None,
    ) -> dict:
        refreshed_after_401 = False

        def request(attempt: int) -> dict:
            nonlocal refreshed_after_401
            before_attempt(attempt)
            token = self.valid_access_token(connection)
            try:
                return self._youtube_request(path, token, method)
            except ProviderError as error:
                if error.status != 401 or refreshed_after_401:
                    raise
                token = self.valid_access_token(connection, force_refresh=True)
                refreshed_after_401 = True
                before_attempt(attempt + 1)
                return self._youtube_request(path, token, method)

        try:
            return with_retries(
                request,
                retries=self.config.max_retries,
                base_delay_ms=1_000,
                max_delay_ms=30_000,
                should_retry=lambda error: (
                    bool(getattr(error, "retryable", False))
                    and not getattr(error, "quota_exceeded", False)
                    and not getattr(error, "authentication_required", False)
                ),
                sleep=self.sleep,
            )
        except Exception as error:
            if connection and (
                getattr(error, "status", None) == 401
                or getattr(error, "authentication_required", False)
            ):
                status = (
                    "RECONNECT_REQUIRED"
                    if getattr(error, "code", None) == "REFRESH_TOKEN_MISSING"
                    or connection.get("connectionStatus") == "RECONNECT_REQUIRED"
                    else "AUTHENTICATION_INVALID"
                )
                try:
                    self._mark_health(connection, status, getattr(error, "code", None))
                except Exception:
                    pass
            raise

    def ratings(
        self,
        connection: dict | None,
        video_ids: list[str],
        before_attempt: Callable[[int], None] = lambda _attempt: None,
    ) -> dict[str, str]:
        if not video_ids:
            return {}
        values: dict[str, str] = {}
        for index in range(0, len(video_ids), 50):
            before_attempt(0)
            ids = video_ids[index : index + 50]
            body = self._authenticated_request(
                connection,
                f"/videos/getRating?id={quote(','.join(ids), safe='')}",
                before_attempt=before_attempt,
            )
            for item in body.get("items", []):
                values[item.get("videoId")] = item.get("rating")
        return values

    def like_video(
        self,
        connection: dict | None,
        video_id: str,
        before_attempt: Callable[[int], None] = lambda _attempt: None,
    ) -> None:
        self._authenticated_request(
            connection,
            f"/videos/rate?id={quote(video_id, safe='')}&rating=like",
            method="POST",
            before_attempt=before_attempt,
        )
