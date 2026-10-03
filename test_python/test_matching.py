from __future__ import annotations

import json
import subprocess
from pathlib import Path

from musicmove_worker.matching import match_track, normalize_string, scan_result_data

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_PATH = ROOT / "test_python" / "fixtures" / "matcher_cases.json"


def _projection(result: dict) -> dict:
    return {
        "matched": result["matched"],
        "closeSecond": result["closeSecond"],
        "videoId": result.get("videoId"),
        "title": result.get("title"),
        "artists": result.get("artists"),
        "score": result.get("score"),
        "confidence": result["confidence"],
        "matchTier": result["matchTier"],
        "reason": result["reason"],
        "candidates": [
            {
                "videoId": candidate["videoId"],
                "score": candidate["score"],
                "scoreBreakdown": candidate["scoreBreakdown"],
                "reasons": candidate["reasons"],
            }
            for candidate in result["candidates"]
        ],
    }


def test_fixture_is_current_javascript_output():
    generated = subprocess.run(
        ["node", "test_python/generate_matcher_fixtures.js"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    assert json.loads(generated.stdout) == json.loads(
        FIXTURE_PATH.read_text(encoding="utf-8")
    )


def test_python_matcher_matches_javascript_fixtures_exactly():
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    for source, expected in fixture["normalization"]:
        assert normalize_string(source) == expected
    for case in fixture["cases"]:
        result = match_track(case["spotify"], case["candidates"], threshold=0.85)
        assert _projection(result) == case["expected"], case["name"]


def test_safe_medium_and_ambiguous_results_preserve_node_semantics():
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    cases = {case["name"]: case for case in fixture["cases"]}
    medium = match_track(
        cases["safe_medium_duration"]["spotify"],
        cases["safe_medium_duration"]["candidates"],
    )
    assert medium["matched"] is False
    assert scan_result_data(medium) == {
        "status": "READY",
        "needsReview": True,
        "matchedYoutubeVideoId": "medium",
        "matchedYoutubeTitle": "Signal",
        "matchedYoutubeArtists": ["The Waves"],
        "confidence": "MEDIUM",
        "score": 0.7604,
        "reason": "Best score 0.7604 is below threshold 0.85.",
    }
    close = match_track(
        cases["close_second"]["spotify"], cases["close_second"]["candidates"]
    )
    assert scan_result_data(close)["status"] == "REVIEW"
    assert scan_result_data(close)["needsReview"] is False

    exact = match_track(
        cases["take_my_mind_exact_identity"]["spotify"],
        cases["take_my_mind_exact_identity"]["candidates"],
    )
    assert exact["videoId"] == "ukxikZCIRBU"
    assert exact["matchTier"] == "EXACT"
    assert scan_result_data(exact) == {
        "status": "READY",
        "needsReview": False,
        "matchedYoutubeVideoId": "ukxikZCIRBU",
        "matchedYoutubeTitle": "Take My Mind",
        "matchedYoutubeArtists": ["WizTheMc", "bees & honey"],
        "confidence": "HIGH",
        "score": 0.92,
        "reason": None,
    }
