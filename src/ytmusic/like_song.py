import argparse
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

try:
    import requests
    import ytmusicapi
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


def trace(enabled, step, **details):
    if not enabled:
        return
    safe_details = {
        key: value
        for key, value in details.items()
        if key not in {"client_secret", "access_token", "refresh_token", "token", "headers", "cookies"}
    }
    print(json.dumps({"trace": step, **safe_details}, ensure_ascii=True), file=sys.stderr, flush=True)


class DiagnosticSession(requests.Session):
    def __init__(self, enabled=False):
        super().__init__()
        self.enabled = enabled
        self.events = []

    def request(self, method, url, **kwargs):
        parsed = urlparse(url)
        json_body = kwargs.get("json") or {}
        event = {
            "method": method,
            "host": parsed.netloc,
            "path": parsed.path,
        }
        if isinstance(json_body, dict):
            if "browseId" in json_body:
                event["browseId"] = json_body["browseId"]
            if "playlistId" in json_body:
                event["playlistId"] = json_body["playlistId"]
            if "target" in json_body:
                target = json_body.get("target") or {}
                event["target"] = {key: target.get(key) for key in ("videoId", "playlistId") if target.get(key)}
        try:
            response = super().request(method, url, **kwargs)
            event["status"] = response.status_code
            event["reason"] = response.reason
            if response.status_code >= 400:
                try:
                    body = response.json()
                    event["error"] = body.get("error", {}).get("message")
                except Exception:
                    event["error"] = "non-json error response"
            return response
        finally:
            self.events.append(event)
            if self.enabled:
                print(json.dumps({"trace": "http_request", **event}, ensure_ascii=True), file=sys.stderr, flush=True)


REQUIRED_BROWSER_HEADERS = {
    "accept",
    "authorization",
    "content-type",
    "x-goog-authuser",
    "x-origin",
    "cookie",
}


def normalize_header_name(name):
    return str(name).strip().lower()


def parse_browser_headers(raw):
    raw = raw.strip()
    if not raw:
        raise ValueError("No browser headers were provided.")

    parsed = {}
    try:
        loaded = json.loads(raw)
        if isinstance(loaded, dict):
            for key, value in loaded.items():
                parsed[normalize_header_name(key)] = str(value).strip()
    except json.JSONDecodeError:
        remembered_key = ""
        for line in raw.splitlines():
            line = line.strip()
            if not line or line.startswith(":"):
                continue
            if ": " in line:
                key, value = line.split(": ", 1)
                parsed[normalize_header_name(key)] = value.strip()
                remembered_key = ""
            elif line.endswith(":"):
                remembered_key = normalize_header_name(line[:-1])
            elif remembered_key:
                parsed[remembered_key] = line.strip()
                remembered_key = ""

    if "x-origin" not in parsed and "origin" in parsed:
        parsed["x-origin"] = parsed["origin"]

    missing = sorted(REQUIRED_BROWSER_HEADERS - set(parsed))
    if missing:
        raise ValueError(f"Missing required browser auth headers: {', '.join(missing)}")

    if "SAPISIDHASH" not in parsed.get("authorization", ""):
        raise ValueError("Authorization header must contain a SAPISIDHASH value from music.youtube.com.")

    if "music.youtube.com" not in parsed.get("x-origin", ""):
        raise ValueError("x-origin must be https://music.youtube.com.")

    essential = {
        "accept": parsed["accept"],
        "authorization": parsed["authorization"],
        "content-type": parsed["content-type"],
        "x-goog-authuser": parsed["x-goog-authuser"],
        "x-origin": parsed["x-origin"],
        "cookie": parsed["cookie"],
    }
    return essential


def essential_headers_raw(headers):
    return "\n".join(f"{key}: {value}" for key, value in headers.items())


def get_ytmusic(args):
    browser_auth_raw = getattr(args, "browser_auth", "") or ""
    browser_auth_path = Path(browser_auth_raw) if browser_auth_raw else None
    oauth_auth_path = Path(args.auth)
    use_browser_auth = bool(browser_auth_path and browser_auth_path.exists())
    auth_path = browser_auth_path if use_browser_auth else oauth_auth_path
    if not auth_path.exists():
        raise FileNotFoundError(
            f"YouTube Music auth file not found at {auth_path}. Run `npm run auth:ytmusic` first."
        )

    client_id = os.environ.get("YTMUSIC_CLIENT_ID", args.client_id or "")
    client_secret = os.environ.get("YTMUSIC_CLIENT_SECRET", args.client_secret or "")
    session = DiagnosticSession(getattr(args, "trace", False))
    trace(
        getattr(args, "trace", False),
        "ytmusic_init_start",
        auth_path=str(auth_path),
        auth_exists=auth_path.exists(),
        auth_mode="browser" if use_browser_auth else "oauth",
        has_client_id=bool(client_id),
        has_client_secret=bool(client_secret),
    )
    if use_browser_auth:
        yt = YTMusic(str(auth_path), requests_session=session)
    elif client_id and client_secret:
        yt = YTMusic(
            str(auth_path),
            requests_session=session,
            oauth_credentials=OAuthCredentials(client_id=client_id, client_secret=client_secret, session=session),
        )
    else:
        yt = YTMusic(str(auth_path), requests_session=session)
    trace(getattr(args, "trace", False), "ytmusic_init_ok")
    yt._diagnostic_session = session
    return yt


def auth_summary(yt):
    return {
        "authType": getattr(getattr(yt, "auth_type", None), "name", str(getattr(yt, "auth_type", ""))),
        "hasAuthHeaders": bool(getattr(yt, "_auth_headers", None)),
    }


def exception_summary(exc):
    message = str(exc)
    status = None
    if "HTTP 400" in message:
        status = 400
    elif "HTTP 401" in message:
        status = 401
    elif "HTTP 403" in message:
        status = 403
    return {
        "type": exc.__class__.__name__,
        "httpStatus": status,
        "message": message,
    }


def command_auth_init(args):
    yt = get_ytmusic(args)
    return {"ok": True, "authInit": "OK", **auth_summary(yt)}


def command_account_info(args):
    yt = get_ytmusic(args)
    trace(args.trace, "account_info_start")
    info = yt.get_account_info()
    trace(args.trace, "account_info_ok", keys=sorted(list(info.keys())) if isinstance(info, dict) else None)
    return {
        "ok": True,
        "accountInfo": {
            "type": type(info).__name__,
            "keys": sorted(list(info.keys())) if isinstance(info, dict) else None,
        },
        "requests": getattr(yt, "_diagnostic_session", DiagnosticSession()).events,
    }


def command_setup_browser(args):
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    raw = sys.stdin.read()
    essential = parse_browser_headers(raw)
    ytmusicapi.setup(filepath=str(output_path), headers_raw=essential_headers_raw(essential))

    session = DiagnosticSession(getattr(args, "trace", False))
    yt = YTMusic(str(output_path), requests_session=session)
    summary = auth_summary(yt)
    trace(args.trace, "browser_auth_init_ok", output_path=str(output_path), **summary)
    info = yt.get_account_info()
    trace(args.trace, "browser_auth_account_info_ok", keys=sorted(list(info.keys())) if isinstance(info, dict) else None)
    return {
        "ok": True,
        "browserAuthPath": str(output_path),
        **summary,
        "accountInfo": {
            "type": type(info).__name__,
            "keys": sorted(list(info.keys())) if isinstance(info, dict) else None,
        },
        "requests": session.events,
    }


def command_search(args):
    trace(args.trace, "ytmusic_public_search_init_start")
    yt = YTMusic()
    trace(args.trace, "ytmusic_public_search_init_ok")
    query = args.query.strip()
    results = []
    seen = set()
    filters = [value.strip() for value in args.filters.split(",") if value.strip()]
    for search_filter in filters:
        ytmusic_filter = None if search_filter == "default" else search_filter
        trace(args.trace, "search_start", filter=search_filter, query=query, limit=args.limit, ignore_spelling=False)
        search_results = yt.search(query, filter=ytmusic_filter, limit=args.limit, ignore_spelling=False)
        trace(args.trace, "search_ok", filter=search_filter, count=len(search_results) if isinstance(search_results, list) else None)
        for item in search_results:
            video_id = item.get("videoId")
            if not video_id or video_id in seen:
                continue
            seen.add(video_id)
            results.append(normalize_result(item))
    return {"ok": True, "results": results}


def command_like(args):
    yt = get_ytmusic(args)
    trace(args.trace, "rate_song_start", video_id=args.video_id)
    response = yt.rate_song(args.video_id, LikeStatus.LIKE)
    trace(args.trace, "rate_song_ok", video_id=args.video_id)
    return {"ok": True, "videoId": args.video_id, "response": response}


def command_like_verify(args):
    browser_auth_path = Path(getattr(args, "browser_auth", "") or "")
    if not browser_auth_path.exists():
        raise FileNotFoundError(f"Browser auth file not found at {browser_auth_path}. Run `npm run auth:ytmusic:browser` first.")

    yt = get_ytmusic(args)
    trace(args.trace, "single_track_like_start", video_id=args.video_id)
    response = yt.rate_song(args.video_id, LikeStatus.LIKE)
    trace(args.trace, "single_track_like_ok", video_id=args.video_id)

    trace(args.trace, "single_track_verify_liked_songs_start", limit=args.verify_limit)
    liked = yt.get_liked_songs(limit=args.verify_limit)
    tracks = liked.get("tracks", []) if isinstance(liked, dict) else []
    verified = any(track.get("videoId") == args.video_id for track in tracks)
    trace(args.trace, "single_track_verify_liked_songs_ok", checked=len(tracks), verified=verified)

    return {
        "ok": True,
        "videoId": args.video_id,
        "rateSong": "OK",
        "verification": "OK" if verified else "NOT_FOUND",
        "verified": verified,
        "checkedLikedSongs": len(tracks),
        "responseType": type(response).__name__,
        "requests": getattr(yt, "_diagnostic_session", DiagnosticSession()).events,
    }


def command_liked_ids(args):
    yt = get_ytmusic(args)
    trace(args.trace, "liked_ids_start", limit=args.limit)
    liked = yt.get_liked_songs(limit=args.limit)
    tracks = liked.get("tracks", []) if isinstance(liked, dict) else []
    ids = [track.get("videoId") for track in tracks if track.get("videoId")]
    trace(args.trace, "liked_ids_ok", count=len(ids))
    return {"ok": True, "videoIds": ids, "count": len(ids), "requests": getattr(yt, "_diagnostic_session", DiagnosticSession()).events}


def main():
    parser = argparse.ArgumentParser(description="YouTube Music JSON bridge for the Spotify sync app.")
    parser.add_argument("--auth", required=True)
    parser.add_argument("--browser-auth", default="")
    parser.add_argument("--client-id", default="")
    parser.add_argument("--client-secret", default="")
    parser.add_argument("--trace", action="store_true")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("auth-init")
    subparsers.add_parser("account-info")

    setup_browser = subparsers.add_parser("setup-browser")
    setup_browser.add_argument("--output", required=True)

    search = subparsers.add_parser("search")
    search.add_argument("--query", required=True)
    search.add_argument("--limit", type=int, default=10)
    search.add_argument("--filters", default="songs,videos")

    like = subparsers.add_parser("like")
    like.add_argument("--video-id", required=True)

    like_verify = subparsers.add_parser("like-verify")
    like_verify.add_argument("--video-id", required=True)
    like_verify.add_argument("--verify-limit", type=int, default=10000)

    liked_ids = subparsers.add_parser("liked-ids")
    liked_ids.add_argument("--limit", type=int, default=10000)

    args = parser.parse_args()
    try:
        if args.command == "search":
            payload = command_search(args)
        elif args.command == "auth-init":
            payload = command_auth_init(args)
        elif args.command == "account-info":
            payload = command_account_info(args)
        elif args.command == "setup-browser":
            payload = command_setup_browser(args)
        elif args.command == "like":
            payload = command_like(args)
        elif args.command == "like-verify":
            payload = command_like_verify(args)
        elif args.command == "liked-ids":
            payload = command_liked_ids(args)
        else:
            raise ValueError(f"Unknown command: {args.command}")
        print(json.dumps(payload, ensure_ascii=True))
    except Exception as exc:
        payload = {"ok": False, "error": str(exc), "exception": exception_summary(exc)}
        print(json.dumps(payload, ensure_ascii=True))
        sys.exit(1)


if __name__ == "__main__":
    main()
