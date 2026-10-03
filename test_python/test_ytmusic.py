from typing import ClassVar

from musicmove_worker.providers.ytmusic import (
    TimeoutSession,
    YouTubeMusicProvider,
    normalize_result,
)


class FakeYTMusic:
    instances: ClassVar[list] = []

    def __init__(self, *, requests_session):
        self.session = requests_session
        self.calls = []
        self.__class__.instances.append(self)

    def search(self, query, *, filter, limit, ignore_spelling):
        self.calls.append((query, filter, limit, ignore_spelling))
        if filter == "songs":
            return [
                {
                    "videoId": "a",
                    "title": "Song",
                    "artists": [{"name": "Artist"}],
                    "album": {"name": "Album"},
                    "duration": "3:01",
                    "resultType": "song",
                },
                {
                    "videoId": "shared",
                    "title": "Shared",
                    "artists": ["Artist"],
                    "duration": "1:02:03",
                },
                {"title": "No ID"},
            ]
        return [
            {"videoId": "shared", "title": "Duplicate"},
            {
                "videoId": "b",
                "title": "Video",
                "artists": [],
                "duration": "bad",
                "resultType": "video",
            },
        ]


def test_candidate_normalization_order_and_deduplication():
    FakeYTMusic.instances.clear()
    provider = YouTubeMusicProvider(
        limit=7, timeout_seconds=12, ytmusic_factory=FakeYTMusic
    )
    results = provider.search_track({"title": "Song", "artists": ["Artist"]})
    assert [item["videoId"] for item in results] == ["a", "shared", "b"]
    assert results[0]["artists"] == ["Artist"]
    assert results[0]["album"] == "Album"
    assert results[0]["durationMs"] == 181_000
    assert results[1]["durationMs"] == 3_723_000
    assert results[2]["durationMs"] is None
    instance = FakeYTMusic.instances[0]
    assert instance.calls == [
        ("Song Artist", "songs", 7, False),
        ("Song Artist", "videos", 7, False),
    ]
    assert isinstance(instance.session, TimeoutSession)
    assert instance.session.timeout_seconds == 12


def test_normalize_result_preserves_candidate_metadata():
    raw = {
        "videoId": "id",
        "title": "Title",
        "artists": [{"name": "A"}],
        "album": {"name": "B"},
        "duration": "2:03",
        "resultType": "song",
        "videoType": "MUSIC_VIDEO_TYPE_ATV",
        "category": "Songs",
        "isExplicit": True,
        "feedbackTokens": {"add": "x"},
    }
    normalized = normalize_result(raw)
    assert normalized["durationMs"] == 123_000
    assert normalized["raw"] is raw
