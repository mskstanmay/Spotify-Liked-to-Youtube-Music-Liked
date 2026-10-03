from __future__ import annotations

LIKE_TERMINAL_TRACK_STATUSES = (
    "LIKED",
    "ALREADY_LIKED",
    "REVIEW",
    "NOT_FOUND",
    "FAILED",
    "SKIPPED",
)


def counter_data(groups: list[dict], matched_count: int, phase: str) -> dict:
    counts: dict[str, int] = {}
    added_review_count = 0
    needs_review_count = 0
    for group in groups:
        count = int(group.get("count", group.get("_count", {}).get("_all", 0)))
        status = group["status"]
        counts[status] = counts.get(status, 0) + count
        if group.get("needsReview", group.get("needs_review", False)):
            needs_review_count += count
            if status == "LIKED":
                added_review_count += count
    all_tracks = sum(counts.values())
    if phase == "SCANNING":
        processed = all_tracks - counts.get("PENDING", 0) - counts.get("SCANNING", 0)
    else:
        processed = sum(
            counts.get(status, 0) for status in LIKE_TERMINAL_TRACK_STATUSES
        )
    return {
        "processedTracks": processed,
        "confidentCount": matched_count,
        "likedCount": counts.get("LIKED", 0),
        "alreadyLikedCount": counts.get("ALREADY_LIKED", 0),
        "reviewCount": counts.get("REVIEW", 0),
        "notFoundCount": counts.get("NOT_FOUND", 0),
        "failedCount": counts.get("FAILED", 0),
        "skippedCount": counts.get("SKIPPED", 0),
        "addedReviewCount": added_review_count,
        "needsReviewCount": needs_review_count,
    }


def persisted_counter_data(counters: dict) -> dict:
    return {
        key: value
        for key, value in counters.items()
        if key not in {"addedReviewCount", "needsReviewCount"}
    }
