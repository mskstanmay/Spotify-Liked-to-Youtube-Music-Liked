# Spotify Liked to YouTube Music Liked

Synchronizes your Spotify liked songs into your YouTube Music liked songs. Stage 1 only moves Spotify saved tracks to YouTube Music likes; it does not create playlists or do mood, clustering, KNN, or recommendation work.

The app is intentionally conservative. It searches YouTube Music, scores candidates, likes only high-confidence matches, and writes uncertain items to `data/review.json`.

## Architecture

- Node.js CLI: orchestration, Spotify OAuth, Spotify pagination, matching, state, logging.
- Python bridge: YouTube Music search and liking through `ytmusicapi`.
- Local data files under `data/`: Spotify token, fetched library, YouTube Music auth, sync state, review items.
- Matcher tests under `test/`: run without Spotify or YouTube Music credentials.

## Requirements

- Node.js 18 or newer. This project uses built-in `fetch`; Node 24 works.
- npm.
- Python 3.10 or newer.
- A Spotify Developer app.
- A Google Cloud OAuth client for YouTube Music / YouTube Data API use with `ytmusicapi`.

## Node Setup

```bash
npm install
```

## Python Virtual Environment

Create the virtual environment inside this project. Do not install Python dependencies globally.

Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

Windows CMD:

```cmd
python -m venv .venv
.\.venv\Scripts\activate.bat
python -m pip install -r requirements.txt
```

Linux/macOS:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

The Node app calls `.venv\Scripts\python.exe` on Windows and `.venv/bin/python` on Linux/macOS.

## Spotify Setup

1. Open the Spotify Developer Dashboard.
2. Create an app.
3. Add this redirect URI exactly:

```text
http://127.0.0.1:8888/callback
```

4. Copy `.env.example` to `.env`.
5. Fill in:

```env
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback
```

The required Spotify scope is:

```text
user-library-read
```

Authenticate:

```bash
npm run auth:spotify
```

The token is saved to `data/spotify-token.json`, which is ignored by Git.

## YouTube Music Setup

This project uses `ytmusicapi`. As of the current `ytmusicapi` documentation, OAuth setup needs a YouTube Data API OAuth client ID and secret, using the TV / limited-input-device flow. Put those values in `.env` if your setup requires them:

```env
YTMUSIC_CLIENT_ID=
YTMUSIC_CLIENT_SECRET=
YTMUSIC_AUTH_PATH=data/ytmusic-oauth.json
```

Then run:

```bash
npm run auth:ytmusic
```

Follow the prompts. The generated auth file is stored under `data/` and ignored by Git.

## Commands

```bash
npm start
npm run sync
```

Runs the normal synchronization.

```bash
npm run fetch
```

Fetches all Spotify liked songs and writes `data/spotify-liked.json`.

```bash
npm run match
```

Searches and matches without liking YouTube Music tracks.

```bash
npm run retry
```

Retries tracks with `failed` status.

```bash
npm run review
```

Prints tracks that need manual review.

Useful options:

```bash
npm run sync -- --refresh-spotify
npm run sync -- --force
npm run sync -- --dry-run
```

## Resume and Retry Behavior

The sync writes `data/sync-results.json` after every track. Completed statuses are skipped on the next run:

- `liked`
- `already_liked`
- `not_found`
- `ambiguous`

Failures are recorded as `failed` and can be retried with `npm run retry`. Use `--force` to rebuild state and process everything again.

## Ambiguous Matches

The matcher scores normalized title, artists, duration, album, result type, and version indicators such as live, remix, cover, acoustic, sped-up, slowed, and instrumental. Only high-confidence matches above `MATCH_CONFIDENCE_THRESHOLD` are liked automatically.

Uncertain tracks are written to `data/review.json` with the Spotify track, candidate list, scores, selected candidate, and reason.

## Configuration

Defaults are shown in `.env.example`:

```env
MATCH_CONFIDENCE_THRESHOLD=0.85
REQUEST_DELAY_MS=250
MAX_RETRIES=3
YTMUSIC_SEARCH_LIMIT=10
YTMUSIC_LIKED_SONGS_LIMIT=10000
DEBUG_SYNC=false
```

Increase `REQUEST_DELAY_MS` if either API starts throttling. Set `DEBUG_SYNC=true` for retry details.

## Tests

```bash
npm test
```

The tests cover matching logic only and do not contact Spotify or YouTube Music.

## Security

Never commit `.env`, `.venv/`, `data/`, tokens, cookies, generated YouTube Music auth files, or personal library data. `.gitignore` excludes these by default.

## Current Limitations

- You should inspect `data/review.json` manually before deciding what to do with ambiguous tracks.
- `already_liked` detection depends on the YouTube Music liked-songs list returning the matched video ID.
- YouTube Music behavior comes from the unofficial `ytmusicapi` package and may change with YouTube Music internals.
