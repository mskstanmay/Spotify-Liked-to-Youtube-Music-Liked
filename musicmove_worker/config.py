from __future__ import annotations

import base64
import os
from collections.abc import Mapping
from dataclasses import dataclass
from urllib.parse import urlparse


def _positive_int(environment: Mapping[str, str], name: str, default: int) -> int:
    try:
        value = int(environment.get(name, ""))
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _score(environment: Mapping[str, str], name: str, default: float) -> float:
    raw = environment.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if 0 <= value <= 1 else default


def _validate_key(value: str) -> None:
    try:
        decoded = base64.b64decode(value, validate=True)
    except Exception as exc:
        raise ValueError(
            "TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key."
        ) from exc
    if len(decoded) != 32 or base64.b64encode(decoded).decode("ascii") != value:
        raise ValueError("TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.")


@dataclass(frozen=True, slots=True)
class WorkerConfig:
    database_url: str
    token_encryption_key: str
    spotify_client_id: str
    google_client_id: str
    google_client_secret: str
    worker_poll_ms: int = 1_500
    worker_lease_ms: int = 60_000
    request_delay_ms: int = 250
    max_retries: int = 3
    match_confidence_threshold: float = 0.85
    auto_review_min_score: float = 0.72
    ytmusic_search_limit: int = 10
    app_env: str = "development"
    staging_database_identifier: str = ""
    provider_timeout_seconds: float = 30.0
    google_refresh_lease_ms: int = 35_000

    @classmethod
    def from_env(cls, environment: Mapping[str, str] | None = None) -> WorkerConfig:
        env = os.environ if environment is None else environment
        required = (
            "DATABASE_URL",
            "TOKEN_ENCRYPTION_KEY",
            "SPOTIFY_CLIENT_ID",
            "GOOGLE_CLIENT_ID",
            "GOOGLE_CLIENT_SECRET",
        )
        missing = [name for name in required if not env.get(name)]
        if missing:
            raise ValueError(
                f"Missing required worker configuration: {', '.join(missing)}"
            )

        key = env["TOKEN_ENCRYPTION_KEY"]
        _validate_key(key)
        app_env = env.get("APP_ENV", "development")
        marker = env.get("STAGING_DATABASE_IDENTIFIER", "")
        database_url = env["DATABASE_URL"]
        if app_env == "staging":
            lowered = marker.lower()
            if len(lowered) < 6 or lowered in {
                "postgres",
                "supabase",
                "staging",
                "project",
            }:
                raise ValueError(
                    "Invalid staging configuration: STAGING_DATABASE_IDENTIFIER is required and must be specific."
                )
            parsed = urlparse(database_url)
            if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname:
                raise ValueError(
                    "Invalid staging configuration: DATABASE_URL must be a valid PostgreSQL URL."
                )
            identity = f"{parsed.username or ''}{parsed.hostname}{parsed.path}".lower()
            if lowered not in identity:
                raise ValueError(
                    "Invalid staging configuration: DATABASE_URL does not match STAGING_DATABASE_IDENTIFIER."
                )

        return cls(
            database_url=database_url,
            token_encryption_key=key,
            spotify_client_id=env["SPOTIFY_CLIENT_ID"],
            google_client_id=env["GOOGLE_CLIENT_ID"],
            google_client_secret=env["GOOGLE_CLIENT_SECRET"],
            worker_poll_ms=_positive_int(env, "WORKER_POLL_MS", 1_500),
            worker_lease_ms=max(60_000, _positive_int(env, "WORKER_LEASE_MS", 60_000)),
            request_delay_ms=_positive_int(env, "REQUEST_DELAY_MS", 250),
            max_retries=_positive_int(env, "MAX_RETRIES", 3),
            match_confidence_threshold=_score(env, "MATCH_CONFIDENCE_THRESHOLD", 0.85),
            auto_review_min_score=_score(env, "AUTO_REVIEW_MIN_SCORE", 0.72),
            ytmusic_search_limit=_positive_int(env, "YTMUSIC_SEARCH_LIMIT", 10),
            app_env=app_env,
            staging_database_identifier=marker,
        )
