import base64

import pytest

from musicmove_worker.config import WorkerConfig

KEY = base64.b64encode(bytes(range(32))).decode()


def base_env():
    return {
        "DATABASE_URL": "postgresql://worker:pass@test-db.example/musicmove_test",
        "TOKEN_ENCRYPTION_KEY": KEY,
        "SPOTIFY_CLIENT_ID": "spotify",
        "GOOGLE_CLIENT_ID": "google",
        "GOOGLE_CLIENT_SECRET": "secret",
    }


def test_only_worker_configuration_is_required():
    config = WorkerConfig.from_env(base_env())
    assert config.worker_lease_ms == 60_000
    assert config.match_confidence_threshold == 0.85
    assert config.auto_review_min_score == 0.72


def test_staging_database_marker_must_be_specific_and_match():
    environment = {
        **base_env(),
        "APP_ENV": "staging",
        "STAGING_DATABASE_IDENTIFIER": "musicmove_test",
    }
    assert WorkerConfig.from_env(environment).app_env == "staging"
    with pytest.raises(ValueError, match="does not match"):
        WorkerConfig.from_env(
            {**environment, "STAGING_DATABASE_IDENTIFIER": "other_database"}
        )


def test_invalid_encryption_key_is_rejected():
    with pytest.raises(ValueError, match="32-byte"):
        WorkerConfig.from_env({**base_env(), "TOKEN_ENCRYPTION_KEY": "not-a-key"})
