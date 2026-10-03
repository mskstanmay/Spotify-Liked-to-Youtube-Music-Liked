from __future__ import annotations

from typing import Any

import requests
from ytmusicapi import YTMusic


class TimeoutSession(requests.Session):
    """A requests session that applies a real socket/read timeout to every call."""

    def __init__(self, timeout_seconds: float = 30.0) -> None:
        super().__init__()
        self.timeout_seconds = timeout_seconds

    def request(self, method, url, **kwargs):
        if kwargs.get("timeout") is None:
            kwargs["timeout"] = self.timeout_seconds
        return super().request(method, url, **kwargs)


def parse_duration(duration: Any) -> int | None:
    if not duration or not isinstance(duration, str):
        return None
    try:
        seconds = 0
        for part in duration.split(":"):
            seconds = seconds * 60 + int(part)
        return seconds * 1_000
    except ValueError:
        return None


def normalize_artists(artists: Any) -> list[str]:
    if not isinstance(artists, list):
        return []
    normalized: list[str] = []
    for artist in artists:
        if isinstance(artist, dict) and artist.get("name"):
            normalized.append(artist["name"])
        elif isinstance(artist, str):
            normalized.append(artist)
    return normalized


def normalize_result(result: dict) -> dict:
    album = result.get("album")
    return {
        "videoId": result.get("videoId"),
        "title": result.get("title"),
        "artists": normalize_artists(result.get("artists")),
        "album": album.get("name") if isinstance(album, dict) else album,
        "duration": result.get("duration"),
        "durationMs": parse_duration(result.get("duration")),
        "resultType": result.get("resultType"),
        "videoType": result.get("videoType"),
        "category": result.get("category"),
        "isExplicit": result.get("isExplicit"),
        "feedbackTokens": result.get("feedbackTokens"),
        "raw": result,
    }


class YouTubeMusicProvider:
    def __init__(
        self, *, limit: int = 10, timeout_seconds: float = 30.0, ytmusic_factory=YTMusic
    ) -> None:
        self.limit = limit
        self.timeout_seconds = timeout_seconds
        self.ytmusic_factory = ytmusic_factory

    def search_track(self, track: dict) -> list[dict]:
        query = (
            f"{track.get('title', '')} {' '.join(track.get('artists') or [])}".strip()
        )
        session = TimeoutSession(self.timeout_seconds)
        try:
            ytmusic = self.ytmusic_factory(requests_session=session)
            results: list[dict] = []
            seen: set[str] = set()
            for search_filter in ("songs", "videos"):
                search_results = ytmusic.search(
                    query,
                    filter=search_filter,
                    limit=self.limit,
                    ignore_spelling=False,
                )
                for item in search_results:
                    video_id = item.get("videoId")
                    if not video_id or video_id in seen:
                        continue
                    seen.add(video_id)
                    results.append(normalize_result(item))
            return results
        finally:
            session.close()
