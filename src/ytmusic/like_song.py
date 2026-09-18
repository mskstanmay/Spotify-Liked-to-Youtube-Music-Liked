import argparse
import json
import os
import sys
from pathlib import Path

try:
    from ytmusicapi import OAuthCredentials, YTMusic
    from ytmusicapi.models.content.enums import LikeStatus
except Exception as exc:  # pragma: no cover - exercised before dependency install
    print(json.dumps({"ok": False, "error": f"ytmusicapi is not available: {exc}"}))
    sys.exit(1)


def parse_duration(duration):
    if not duration or not isinstance(duration, str):
        return None
    parts = duration.split(":")
    try:
        seconds = 0
        for part in parts:
            seconds = seconds * 60 + int(part)
        return seconds * 1000
    except ValueError:
        return None


def normalize_artists(artists):
    if not isinstance(artists, list):
        return []
    normalized = []
    for artist in artists:
        if isinstance(artist, dict) and artist.get("name"):
            normalized.append(artist["name"])
        elif isinstance(artist, str):
            normalized.append(artist)
    return normalized


def normalize_result(result):
    return {
        "videoId": result.get("videoId"),
        "title": result.get("title"),
        "artists": normalize_artists(result.get("artists")),
        "album": (result.get("album") or {}).get("name") if isinstance(result.get("album"), dict) else result.get("album"),
        "duration": result.get("duration"),
        "durationMs": parse_duration(result.get("duration")),
        "resultType": result.get("resultType"),
        "videoType": result.get("videoType"),
        "category": result.get("category"),
        "isExplicit": result.get("isExplicit"),
        "feedbackTokens": result.get("feedbackTokens"),
        "raw": result,
    }


def get_ytmusic(args):
    auth_path = Path(args.auth)
    if not auth_path.exists():
        raise FileNotFoundError(
            f"YouTube Music auth file not found at {auth_path}. Run `npm run auth:ytmusic` first."
        )

    client_id = os.environ.get("YTMUSIC_CLIENT_ID", args.client_id or "")
    client_secret = os.environ.get("YTMUSIC_CLIENT_SECRET", args.client_secret or "")
    if client_id and client_secret:
        return YTMusic(str(auth_path), oauth_credentials=OAuthCredentials(client_id=client_id, client_secret=client_secret))
    return YTMusic(str(auth_path))


def command_search(args):
    yt = get_ytmusic(args)
    query = args.query.strip()
    results = []
    seen = set()
    for search_filter in ("songs", "videos"):
        for item in yt.search(query, filter=search_filter, limit=args.limit, ignore_spelling=True):
            video_id = item.get("videoId")
            if not video_id or video_id in seen:
                continue
            seen.add(video_id)
            results.append(normalize_result(item))
    return {"ok": True, "results": results}


def command_like(args):
    yt = get_ytmusic(args)
    response = yt.rate_song(args.video_id, LikeStatus.LIKE)
    return {"ok": True, "videoId": args.video_id, "response": response}


def command_liked_ids(args):
    yt = get_ytmusic(args)
    liked = yt.get_liked_songs(limit=args.limit)
    tracks = liked.get("tracks", []) if isinstance(liked, dict) else []
    ids = [track.get("videoId") for track in tracks if track.get("videoId")]
    return {"ok": True, "videoIds": ids, "count": len(ids)}


def main():
    parser = argparse.ArgumentParser(description="YouTube Music JSON bridge for the Spotify sync app.")
    parser.add_argument("--auth", required=True)
    parser.add_argument("--client-id", default="")
    parser.add_argument("--client-secret", default="")
    subparsers = parser.add_subparsers(dest="command", required=True)

    search = subparsers.add_parser("search")
    search.add_argument("--query", required=True)
    search.add_argument("--limit", type=int, default=10)

    like = subparsers.add_parser("like")
    like.add_argument("--video-id", required=True)

    liked_ids = subparsers.add_parser("liked-ids")
    liked_ids.add_argument("--limit", type=int, default=10000)

    args = parser.parse_args()
    try:
        if args.command == "search":
            payload = command_search(args)
        elif args.command == "like":
            payload = command_like(args)
        elif args.command == "liked-ids":
            payload = command_liked_ids(args)
        else:
            raise ValueError(f"Unknown command: {args.command}")
        print(json.dumps(payload, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
