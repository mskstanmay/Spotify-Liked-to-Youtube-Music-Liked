from musicmove_worker.state import counter_data, persisted_counter_data


def test_counter_recomputation_matches_node_and_derives_review_counts():
    groups = [
        {"status": "LIKED", "needsReview": False, "count": 3},
        {"status": "LIKED", "needsReview": True, "count": 2},
        {"status": "ALREADY_LIKED", "needsReview": True, "count": 1},
        {"status": "REVIEW", "needsReview": False, "count": 4},
        {"status": "READY", "needsReview": True, "count": 1},
        {"status": "FAILED", "needsReview": True, "count": 1},
    ]
    counters = counter_data(groups, matched_count=8, phase="LIKING")
    assert counters == {
        "processedTracks": 11,
        "confidentCount": 8,
        "likedCount": 5,
        "alreadyLikedCount": 1,
        "reviewCount": 4,
        "notFoundCount": 0,
        "failedCount": 1,
        "skippedCount": 0,
        "addedReviewCount": 2,
        "needsReviewCount": 5,
    }
    persisted = persisted_counter_data(counters)
    assert "addedReviewCount" not in persisted
    assert "needsReviewCount" not in persisted


def test_scanning_processed_excludes_pending_and_scanning():
    counters = counter_data(
        [
            {"status": "PENDING", "needsReview": False, "count": 2},
            {"status": "SCANNING", "needsReview": False, "count": 1},
            {"status": "READY", "needsReview": False, "count": 3},
            {"status": "REVIEW", "needsReview": False, "count": 2},
        ],
        matched_count=3,
        phase="SCANNING",
    )
    assert counters["processedTracks"] == 5
