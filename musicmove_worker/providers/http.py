from __future__ import annotations

import math
import re
from typing import Any

import httpx

MAX_RETRY_AFTER_MS = 60_000
DAILY_QUOTA_REASONS = {
    "quotaExceeded",
    "dailyLimitExceeded",
    "dailyLimitExceededUnreg",
    "variableTermExpiredDailyExceeded",
}
TRANSIENT_RATE_REASONS = {
    "rateLimitExceeded",
    "userRateLimitExceeded",
    "userRateLimitExceededUnreg",
    "servingLimitExceeded",
    "concurrentLimitExceeded",
    "uploadRateLimitExceeded",
}


class ProviderError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        provider: str | None = None,
        status: int | None = None,
        code: str | None = None,
        retryable: bool = False,
        authentication_required: bool = False,
        quota_exceeded: bool = False,
        retry_after_ms: int | None = None,
    ) -> None:
        super().__init__(message)
        self.provider = provider
        self.status = status
        self.code = code
        self.retryable = retryable
        self.authentication_required = authentication_required
        self.quota_exceeded = quota_exceeded
        self.retry_after_ms = retry_after_ms


def retry_after_ms(
    response: httpx.Response, maximum: int = MAX_RETRY_AFTER_MS
) -> int | None:
    raw = response.headers.get("retry-after")
    if not raw or not re.fullmatch(r"\d+(?:\.\d+)?", raw.strip()):
        return None
    milliseconds = math.ceil(float(raw) * 1_000)
    if milliseconds < 0 or not math.isfinite(milliseconds):
        return None
    return min(milliseconds, maximum)


def error_reason(body: Any) -> str:
    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, dict):
        errors = error.get("errors")
        if (
            isinstance(errors, list)
            and errors
            and isinstance(errors[0], dict)
            and errors[0].get("reason")
        ):
            return str(errors[0]["reason"])
        if error.get("reason"):
            return str(error["reason"])
        if isinstance(error.get("status"), str):
            return error["status"]
    if isinstance(error, str):
        return error
    return "provider_error"


def json_response(response: httpx.Response, provider: str) -> Any:
    try:
        body = response.json()
    except Exception:
        body = {}
    if response.is_success:
        return body
    reason = error_reason(body)
    daily_quota = provider == "YouTube" and reason in DAILY_QUOTA_REASONS
    transient_rate = response.status_code == 429 or reason in TRANSIENT_RATE_REASONS
    raise ProviderError(
        f"{provider} request failed.",
        provider=provider,
        status=response.status_code,
        code=str(reason),
        retryable=not daily_quota and (transient_rate or response.status_code >= 500),
        authentication_required=response.status_code == 401
        or reason == "invalid_grant",
        quota_exceeded=daily_quota,
        retry_after_ms=retry_after_ms(response),
    )


def provider_request(
    client: httpx.Client, method: str, url: str, provider: str, **kwargs
) -> httpx.Response:
    try:
        return client.request(method, url, **kwargs)
    except httpx.TimeoutException as exc:
        raise ProviderError(
            f"{provider} is temporarily unavailable.",
            provider=provider,
            code="TIMEOUT",
            retryable=True,
        ) from exc
    except httpx.RequestError as exc:
        raise ProviderError(
            f"{provider} is temporarily unavailable.",
            provider=provider,
            code="NETWORK_ERROR",
            retryable=True,
        ) from exc


def ensure_connection_usable(connection: dict | None, provider: str) -> None:
    if connection and connection.get("connectionStatus", "ACTIVE") != "ACTIVE":
        raise ProviderError(
            f"{provider} needs to be connected again.",
            provider=provider,
            code=connection.get("lastAuthErrorCode") or "RECONNECT_REQUIRED",
            authentication_required=True,
        )
