import pytest

from musicmove_worker.retry import with_retries


class RetryableError(RuntimeError):
    retryable = True
    retry_after_ms = None


def test_max_retries_means_initial_attempt_plus_three_retries():
    attempts = []
    delays = []

    def fail(attempt):
        attempts.append(attempt)
        raise RetryableError("no")

    with pytest.raises(RetryableError):
        with_retries(
            fail,
            retries=3,
            base_delay_ms=100,
            should_retry=lambda error: error.retryable,
            sleep=delays.append,
        )
    assert attempts == [0, 1, 2, 3]
    assert delays == [0.1, 0.2, 0.4]
