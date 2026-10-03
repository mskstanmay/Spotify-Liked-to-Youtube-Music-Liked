"""Optional Node/Python interoperability tests against a dedicated PostgreSQL DB.

Set TEST_DATABASE_URL to a database whose name contains ``test``.  The suite
applies the existing Prisma migrations and deletes rows in that database.
Production/staging database URLs are intentionally rejected.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

import psycopg
import pytest
from psycopg.rows import dict_row

from musicmove_worker.db import Database, LeaseLostError

ROOT = Path(__file__).resolve().parents[1]
DATABASE_URL = os.environ.get("TEST_DATABASE_URL")

if not DATABASE_URL:
    pytest.skip("TEST_DATABASE_URL is not set", allow_module_level=True)

parsed_database_url = urlparse(DATABASE_URL)
database_name = parsed_database_url.path.lstrip("/").lower()
if (
    parsed_database_url.scheme not in {"postgres", "postgresql"}
    or "test" not in database_name
):
    raise RuntimeError(
        "TEST_DATABASE_URL must be PostgreSQL and name a dedicated database "
        'containing "test" because this suite deletes rows.'
    )


def _node(script: str, *, stdin: str | None = None) -> str:
    environment = {**os.environ, "DATABASE_URL": DATABASE_URL}
    executable = "node.exe" if sys.platform == "win32" else "node"
    result = subprocess.run(
        [executable, "-e", script],
        cwd=ROOT,
        env=environment,
        input=stdin,
        capture_output=True,
        check=True,
        text=True,
        encoding="utf-8",
    )
    return result.stdout.strip()


def _node_process(script: str) -> subprocess.Popen:
    environment = {**os.environ, "DATABASE_URL": DATABASE_URL}
    executable = "node.exe" if sys.platform == "win32" else "node"
    return subprocess.Popen(
        [executable, "-e", script],
        cwd=ROOT,
        env=environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )


@pytest.fixture(scope="session", autouse=True)
def migrated_database():
    npx = "npx.cmd" if sys.platform == "win32" else "npx"
    subprocess.run(
        [npx, "prisma", "migrate", "deploy"],
        cwd=ROOT,
        env={**os.environ, "DATABASE_URL": DATABASE_URL},
        check=True,
    )


@pytest.fixture()
def database(migrated_database):
    with psycopg.connect(DATABASE_URL) as connection:
        connection.execute('DELETE FROM "WorkerRuntime"')
        connection.execute('DELETE FROM "User"')
    db = Database(DATABASE_URL, min_size=1, max_size=6)
    db.open()
    try:
        yield db
    finally:
        db.close()


def _node_create_migration(*, status="SCANNING", phase="SCANNING", with_track=False):
    script = f"""
const {{ PrismaClient }} = require('@prisma/client');
const prisma = new PrismaClient({{ datasourceUrl: process.env.DATABASE_URL }});
(async () => {{
  const user = await prisma.user.create({{ data: {{}} }});
  const migration = await prisma.migration.create({{ data: {{ userId: user.id, status: '{status}', phase: '{phase}' }} }});
  let track = null;
  if ({str(with_track).lower()}) {{
    track = await prisma.migrationTrack.create({{ data: {{
      migrationId: migration.id, position: 1, spotifyTrackId: 'node-track',
      spotifyTitle: 'Node Song', spotifyArtists: ['Node Artist'], status: 'REVIEW'
    }} }});
  }}
  process.stdout.write(JSON.stringify({{ user, migration, track }}));
}})().finally(() => prisma.$disconnect());
"""
    return json.loads(_node(script))


def test_node_created_migration_is_claimed_and_fenced_by_python(database):
    created = _node_create_migration()
    job = database.claim_migration("python-worker", 60_000)
    assert job["id"] == created["migration"]["id"]
    assert job["workerId"] == "python-worker"
    assert job["leaseVersion"] == 1
    assert database.owns(job, "python-worker", ["SCANNING"])

    # Simulate the existing Node pause transaction revoking worker ownership.
    script = f"""
const {{ PrismaClient }} = require('@prisma/client');
const prisma = new PrismaClient({{ datasourceUrl: process.env.DATABASE_URL }});
(async () => {{
  await prisma.migration.update({{ where: {{ id: {json.dumps(job["id"])} }}, data: {{ status: 'PAUSED', workerId: null, lockedUntil: null }} }});
}})().finally(() => prisma.$disconnect());
"""
    _node(script)
    assert database.owns(job, "python-worker", ["SCANNING"]) is False
    with pytest.raises(LeaseLostError):
        database.update_migration(
            job, "python-worker", ["SCANNING"], 60_000, {"processedTracks": 1}
        )


def test_node_and_python_migration_claim_race_has_one_winner(database):
    created = _node_create_migration()
    script = """
const { PrismaClient } = require('@prisma/client');
const { MigrationWorker } = require('./src/worker/migrationWorker');
const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
process.stdin.once('data', async () => {
  try {
    const worker = new MigrationWorker({ prisma, id: 'node-worker', config: { workerLeaseMs: 60000 }, logger: { info() {}, error() {} } });
    const job = await worker.claim();
    process.stdout.write(JSON.stringify(job ? { id: job.id, workerId: job.workerId } : null));
  } finally { await prisma.$disconnect(); }
});
"""
    process = _node_process(script)
    result: dict = {}

    def python_claim():
        result["python"] = database.claim_migration("python-worker", 60_000)

    thread = threading.Thread(target=python_claim)
    thread.start()
    stdout, stderr = process.communicate("go\n", timeout=10)
    thread.join(timeout=10)
    assert process.returncode == 0, stderr
    node_claim = json.loads(stdout)
    winners = [value for value in (node_claim, result["python"]) if value]
    assert len(winners) == 1
    assert winners[0]["id"] == created["migration"]["id"]


def test_node_and_python_video_like_race_has_one_owner(database):
    created = _node_create_migration(status="RUNNING", phase="LIKING")
    user_id = created["user"]["id"]
    script = f"""
const {{ PrismaClient }} = require('@prisma/client');
const {{ tryClaimVideoLike }} = require('./src/worker/videoLikeCoordinator');
const prisma = new PrismaClient({{ datasourceUrl: process.env.DATABASE_URL }});
process.stdin.once('data', async () => {{
  try {{
    const result = await tryClaimVideoLike(prisma, {{ userId: {json.dumps(user_id)}, videoId: 'shared-video', ownerId: 'node-owner', lockedUntil: new Date(Date.now() + 60000) }});
    process.stdout.write(JSON.stringify({{ state: result.state }}));
  }} finally {{ await prisma.$disconnect(); }}
}});
"""
    process = _node_process(script)
    result: dict = {}

    def python_claim():
        from datetime import timedelta

        from musicmove_worker.db import utcnow

        result["python"] = database.try_claim_video_like(
            user_id, "shared-video", "python-owner", utcnow() + timedelta(seconds=60)
        )

    thread = threading.Thread(target=python_claim)
    thread.start()
    stdout, stderr = process.communicate("go\n", timeout=10)
    thread.join(timeout=10)
    assert process.returncode == 0, stderr
    states = [json.loads(stdout)["state"], result["python"]["state"]]
    assert sorted(states) == ["BUSY", "CLAIMED"]


def test_python_updated_at_candidates_arrays_ids_and_node_serializer(database):
    _node_create_migration()
    job = database.claim_migration("python-worker", 60_000)
    before = job["updatedAt"]
    time.sleep(0.01)
    database.update_migration(
        job,
        "python-worker",
        ["SCANNING"],
        60_000,
        {"currentTrackTitle": "Fetching your Spotify library"},
    )
    database.finalize_spotify_fetch(
        job,
        "python-worker",
        60_000,
        [
            {
                "spotifyTrackId": "spotify-1",
                "title": "Python Song",
                "artists": ["One", "Two"],
                "album": "Album",
                "durationMs": 123_000,
                "spotifyUrl": "https://spotify.test/1",
            }
        ],
        1,
    )
    track = database.next_scan_track(job["id"])
    assert track["id"].startswith("c") and len(track["id"]) == 25
    assert track["spotifyArtists"] == ["One", "Two"]
    assert track["createdAt"].microsecond % 1_000 == 0
    assert database.begin_scan_track(job, "python-worker", 60_000, track)
    database.save_scan_result(
        job,
        "python-worker",
        60_000,
        track,
        {
            "status": "READY",
            "needsReview": True,
            "matchedYoutubeVideoId": "youtube-1",
            "matchedYoutubeTitle": "Python Song",
            "matchedYoutubeArtists": ["One", "Two"],
            "confidence": "MEDIUM",
            "score": 0.76,
            "reason": "Best score 0.76 is below threshold 0.85.",
        },
        [
            {
                "videoId": "youtube-1",
                "title": "Python Song",
                "artists": ["One", "Two"],
                "album": "Album",
                "durationMs": 124_000,
                "resultType": "song",
                "videoType": "MUSIC_VIDEO_TYPE_ATV",
                "score": 0.76,
                "reasons": ["duration mismatch"],
            }
        ],
    )
    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as connection:
        after = connection.execute(
            'SELECT "updatedAt" FROM "Migration" WHERE "id" = %s', (job["id"],)
        ).fetchone()["updatedAt"]
    assert after > before
    assert after.microsecond % 1_000 == 0

    script = f"""
const {{ PrismaClient }} = require('@prisma/client');
const {{ trackJson }} = require('./src/migration/serialize');
const prisma = new PrismaClient({{ datasourceUrl: process.env.DATABASE_URL }});
(async () => {{
  const track = await prisma.migrationTrack.findFirst({{ where: {{ migrationId: {json.dumps(job["id"])} }}, include: {{ candidates: {{ orderBy: {{ position: 'asc' }} }} }} }});
  process.stdout.write(JSON.stringify(trackJson(track, true)));
}})().finally(() => prisma.$disconnect());
"""
    serialized = json.loads(_node(script))
    assert serialized["needsReview"] is True
    assert serialized["match"]["videoId"] == "youtube-1"
    assert serialized["match"]["artists"] == ["One", "Two"]
    assert serialized["candidates"][0]["reasons"] == ["duration mismatch"]


def test_python_completion_uses_existing_enum_and_terminal_rules(database):
    created = _node_create_migration(status="QUEUED", phase="LIKING", with_track=True)
    job = database.claim_migration("python-worker", 60_000)
    database.begin_migration(job, "python-worker", 60_000)
    assert database.complete_if_finished(job, "python-worker", 60_000) is True
    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as connection:
        row = connection.execute(
            'SELECT "status"::text AS status, "completedAt", "updatedAt" FROM "Migration" WHERE "id" = %s',
            (created["migration"]["id"],),
        ).fetchone()
    assert row["status"] == "COMPLETED"
    assert row["completedAt"] is not None
    assert row["updatedAt"].microsecond % 1_000 == 0
