from __future__ import annotations

import time
from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")


def with_retries(
    function: Callable[[int], T],
    *,
    retries: int = 3,
    base_delay_ms: int = 500,
    max_delay_ms: int = 60_000,
    should_retry: Callable[[Exception], bool] = lambda _error: True,
    on_retry: Callable[[Exception, int, int], None] = lambda _error, _number, _delay: (
        None
    ),
    sleep: Callable[[float], None] = time.sleep,
) -> T:
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            return function(attempt)
        except Exception as error:
            last_error = error
            if attempt >= retries or not should_retry(error):
                break
            exponential = base_delay_ms * (2**attempt)
            requested = getattr(error, "retry_after_ms", None)
            delay = requested if isinstance(requested, (int, float)) else exponential
            delay = int(max(0, min(delay, max_delay_ms)))
            on_retry(error, attempt + 1, delay)
            sleep(delay / 1_000)
    assert last_error is not None
    raise last_error
