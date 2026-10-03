from __future__ import annotations

import json
import logging
from datetime import UTC, datetime

SAFE_FIELDS = {
    "migrationId",
    "trackId",
    "phase",
    "workerId",
    "operation",
    "provider",
    "retryNumber",
    "durationMs",
    "result",
    "reason",
    "videoId",
    "trackCount",
}


def operation_event(fields: dict, now: datetime | None = None) -> dict:
    moment = now or datetime.now(UTC)
    timestamp = moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    event: dict = {"event": "provider_operation", "timestamp": timestamp}
    for key, value in fields.items():
        if (
            key in SAFE_FIELDS
            and value is not None
            and isinstance(value, (str, int, float, bool))
        ):
            event[key] = value
    return event


def log_operation(logger: logging.Logger, level: str, fields: dict) -> None:
    writer = getattr(logger, level, logger.info)
    writer(
        json.dumps(operation_event(fields), separators=(",", ":"), ensure_ascii=True)
    )
