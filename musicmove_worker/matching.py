from __future__ import annotations

import math
import re
import unicodedata

VERSION_TERMS = {
    "live": ["live", "concert", "session"],
    "remix": ["remix", "edit", "mix"],
    "cover": ["cover", "tribute", "karaoke"],
    "acoustic": ["acoustic", "unplugged"],
    "sped": ["sped up", "speed up", "slowed", "nightcore", "lofi"],
    "instrumental": ["instrumental"],
    "remaster": ["remaster", "remastered"],
}

_UNSET = object()


def _javascript_string(value: object) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    return str(value)


def normalize_string(value: object = _UNSET) -> str:
    text = "" if value is _UNSET else _javascript_string(value)
    normalized = unicodedata.normalize("NFKD", text.lower())
    normalized = re.sub(r"[\u0300-\u036f]", "", normalized)
    normalized = normalized.replace("&", " and ")
    normalized = re.sub(r"\b(feat|ft|featuring)\.?\b", " ", normalized, flags=re.ASCII)
    normalized = re.sub(
        r"\bofficial\s+(audio|video|music video|lyric video)\b",
        " ",
        normalized,
        flags=re.ASCII,
    )
    normalized = re.sub(
        r"\b(audio|lyrics?|visualizer)\b", " ", normalized, flags=re.ASCII
    )
    normalized = re.sub(r"[()[\]{}]", " ", normalized)
    normalized = re.sub(r"[^a-z0-9]+", " ", normalized)
    return re.sub(r"\s+", " ", normalized).strip()


def strip_version_noise(value: object = _UNSET) -> str:
    normalized = normalize_string(value)
    for terms in VERSION_TERMS.values():
        for term in terms:
            pattern = r"\b" + re.escape(term).replace(r"\ ", r"\s+") + r"\b"
            normalized = re.sub(pattern, " ", normalized, flags=re.ASCII)
    return re.sub(r"\s+", " ", normalized).strip()


def _tokens(value: object) -> set[str]:
    return {item for item in normalize_string(value).split(" ") if item}


def jaccard(left_value: object, right_value: object) -> float:
    left, right = _tokens(left_value), _tokens(right_value)
    if not left and not right:
        return 1.0
    return len(left & right) / len(left | right)


def title_similarity(left: object, right: object) -> float:
    clean_left, clean_right = strip_version_noise(left), strip_version_noise(right)
    if clean_left and clean_left == clean_right:
        return 1.0
    if (
        clean_left
        and clean_right
        and (clean_left in clean_right or clean_right in clean_left)
    ):
        return 0.9
    return jaccard(clean_left, clean_right)


def artist_similarity(spotify_artists: list | None, ytm_artists: list | None) -> float:
    spotify = [
        normalize_string(item)
        for item in (spotify_artists or [])
        if normalize_string(item)
    ]
    ytm = [
        normalize_string(item) for item in (ytm_artists or []) if normalize_string(item)
    ]
    if not spotify or not ytm:
        return 0.0
    hits = sum(
        any(
            candidate == artist or artist in candidate or candidate in artist
            for candidate in ytm
        )
        for artist in spotify
    )
    primary_bonus = 0.1 if spotify[0] in ytm else 0.0
    return min(1.0, hits / len(spotify) + primary_bonus)


def album_similarity(spotify_album: object = "", ytm_album: object = "") -> float:
    if not spotify_album or not ytm_album:
        return 0.5
    left, right = normalize_string(spotify_album), normalize_string(ytm_album)
    return 1.0 if left == right else jaccard(left, right)


def duration_similarity(spotify_ms: int | None = 0, ytm_ms: int | None = 0) -> float:
    if not spotify_ms or not ytm_ms:
        return 0.5
    delta = abs(spotify_ms - ytm_ms)
    if delta <= 3_000:
        return 1.0
    if delta <= 8_000:
        return 0.85
    if delta <= 15_000:
        return 0.65
    if delta <= 30_000:
        return 0.35
    return 0.0


def detect_version_flags(value: object = _UNSET) -> dict[str, bool]:
    normalized = normalize_string(value)
    return {
        flag: any(normalize_string(term) in normalized for term in terms)
        for flag, terms in VERSION_TERMS.items()
    }


def version_penalty(spotify_title: object, ytm_title: object) -> float:
    spotify, ytm = detect_version_flags(spotify_title), detect_version_flags(ytm_title)
    penalty = 0.0
    for flag in ("live", "remix", "cover", "acoustic", "sped", "instrumental"):
        if spotify[flag] != ytm[flag]:
            penalty += 0.18 if flag == "remix" else 0.15
    if not spotify["remaster"] and ytm["remaster"]:
        penalty += 0.04
    return min(0.5, penalty)


def result_type_score(candidate: dict) -> float:
    result_type = normalize_string(candidate.get("resultType", ""))
    video_type = normalize_string(candidate.get("videoType", ""))
    if result_type == "song" or "music video type atv" in video_type:
        return 1.0
    if result_type == "video":
        return 0.72
    return 0.45


def _js_four_decimals(value: float) -> float:
    return math.floor(value * 10_000 + 0.5) / 10_000


def score_candidate(spotify_track: dict, candidate: dict) -> dict:
    title = title_similarity(spotify_track.get("title", ""), candidate.get("title", ""))
    artist = artist_similarity(spotify_track.get("artists"), candidate.get("artists"))
    duration = duration_similarity(
        spotify_track.get("durationMs"), candidate.get("durationMs")
    )
    album = album_similarity(spotify_track.get("album"), candidate.get("album"))
    result_type = result_type_score(candidate)
    penalty = version_penalty(
        spotify_track.get("title", ""), candidate.get("title", "")
    )
    raw_score = (
        title * 0.36
        + artist * 0.31
        + duration * 0.18
        + album * 0.08
        + result_type * 0.07
        - penalty
    )
    reasons: list[str] = []
    if title < 0.75:
        reasons.append("title mismatch")
    if artist < 0.75:
        reasons.append("artist mismatch")
    if duration < 0.65:
        reasons.append("duration mismatch")
    if penalty > 0:
        reasons.append("version mismatch")
    if result_type < 0.75:
        reasons.append("non-song result")
    return {
        **candidate,
        "score": max(0.0, min(1.0, _js_four_decimals(raw_score))),
        "scoreBreakdown": {
            "title": title,
            "artist": artist,
            "duration": duration,
            "album": album,
            "type": result_type,
            "penalty": penalty,
        },
        "reasons": reasons,
    }


def confidence_for(score: float, reasons: list[str]) -> str:
    if score >= 0.9 and not reasons:
        return "HIGH"
    if (
        score >= 0.85
        and "artist mismatch" not in reasons
        and "version mismatch" not in reasons
    ):
        return "HIGH"
    if score >= 0.72 and "artist mismatch" not in reasons:
        return "MEDIUM"
    return "LOW"


def uncertainty_reason(best: dict, close_second: bool, threshold: float) -> str:
    if close_second:
        return "Top candidates are too close to choose safely."
    if best["score"] < threshold:
        score = format(best["score"], ".15g")
        formatted_threshold = format(threshold, ".15g")
        return f"Best score {score} is below threshold {formatted_threshold}."
    if best.get("reasons"):
        return ", ".join(best["reasons"])
    return "Match is not high confidence."


def match_track(
    spotify_track: dict, candidates: list[dict] | None, *, threshold: float = 0.85
) -> dict:
    scored = [
        score_candidate(spotify_track, candidate)
        for candidate in (candidates or [])
        if candidate and candidate.get("videoId")
    ]
    scored.sort(key=lambda candidate: candidate["score"], reverse=True)
    if not scored:
        return {
            "matched": False,
            "closeSecond": False,
            "confidence": "LOW",
            "reason": "No YouTube Music candidates returned.",
            "candidates": [],
        }
    best = scored[0]
    close_second = len(scored) > 1 and best["score"] - scored[1]["score"] < 0.04
    confidence = (
        "MEDIUM" if close_second else confidence_for(best["score"], best["reasons"])
    )
    matched = best["score"] >= threshold and confidence == "HIGH" and not close_second
    return {
        "matched": matched,
        "closeSecond": close_second,
        "videoId": best["videoId"] if matched else None,
        "title": best.get("title"),
        "artists": best.get("artists") or [],
        "score": best["score"],
        "confidence": confidence,
        "selectedCandidate": best,
        "candidates": scored,
        "reason": "" if matched else uncertainty_reason(best, close_second, threshold),
    }


def is_usable_auto_review_match(result: dict, minimum_score: float = 0.72) -> bool:
    selected = result.get("selectedCandidate")
    reasons = selected.get("reasons", []) if selected else []
    return bool(
        not result.get("matched")
        and selected
        and result.get("score", 0) >= minimum_score
        and result.get("confidence") == "MEDIUM"
        and not result.get("closeSecond")
        and "artist mismatch" not in reasons
        and "version mismatch" not in reasons
    )


def scan_result_data(result: dict, minimum_score: float = 0.72) -> dict:
    if not result["candidates"]:
        return {"status": "NOT_FOUND", "needsReview": False, "reason": result["reason"]}
    if result["matched"]:
        return {
            "status": "READY",
            "needsReview": False,
            "matchedYoutubeVideoId": result["videoId"],
            "matchedYoutubeTitle": result["title"],
            "matchedYoutubeArtists": result["artists"],
            "confidence": result["confidence"],
            "score": result["score"],
            "reason": None,
        }
    if is_usable_auto_review_match(result, minimum_score):
        selected = result["selectedCandidate"]
        return {
            "status": "READY",
            "needsReview": True,
            "matchedYoutubeVideoId": selected["videoId"],
            "matchedYoutubeTitle": selected.get("title"),
            "matchedYoutubeArtists": selected.get("artists") or [],
            "confidence": result["confidence"],
            "score": result["score"],
            "reason": result["reason"],
        }
    return {
        "status": "REVIEW",
        "needsReview": False,
        "confidence": result["confidence"],
        "score": result["score"],
        "reason": result["reason"],
    }
