# Spotify Liked to YouTube Music Liked

Synchronizes your Spotify liked songs into your YouTube Music liked songs. Stage 1 only moves Spotify saved tracks to YouTube Music likes; it does not create playlists or do mood, clustering, KNN, or recommendation work.

The app is intentionally conservative. It searches YouTube Music, scores candidates, likes only high-confidence matches, and writes uncertain items to `data/review.json`.

The repository now also contains **MusicMove**, a complete React + Fastify web application. The original CLI and its local JSON state remain separate and continue to work unchanged.

## Web application

The web service uses:

- React, Vite, and Tailwind CSS for the responsive UI.
- Fastify for the API and server-side OAuth callbacks.
- PostgreSQL and Prisma for users, encrypted connections, migrations, tracks, and review candidates.
- A separate database-backed worker process with renewable, fenced leases for resumable scans and migrations.
- Spotify Authorization Code OAuth with PKCE and the minimal `user-library-read user-read-private` scopes (`user-read-private` is required by Spotify's current profile endpoint for stable account linking).
- Google server-side OAuth with PKCE and the official YouTube Data API `youtube.force-ssl` scope. Likes are applied with `videos.rate`; existing ratings are read with `videos.getRating`.

The web application never accepts browser cookies, copied headers, provider passwords, or pasted tokens. Provider access and refresh tokens are encrypted at rest and never returned by the API.

### YouTube API limitation

Google does not publish an official YouTube Music library API. MusicMove preserves the proven anonymous `ytmusicapi` search and matcher, but all web-account mutations use the supported YouTube Data API. A YouTube video like normally participates in the user's YouTube/YouTube Music account, but Google does not document a separate YouTube Music library guarantee. `videos.rate` also has a quota cost of 50 units per track, so the default project quota cannot migrate a large library in one day. The worker enters `quota_paused` without losing progress and can resume when quota is available.

### Run the web app locally

1. Create a PostgreSQL database and copy `.env.example` to `.env`.
2. Create a Spotify web app callback for `http://127.0.0.1:3000/api/auth/spotify/callback`.
3. Enable YouTube Data API v3 in Google Cloud, configure an OAuth consent screen, and create a Web application callback for `http://127.0.0.1:3000/api/auth/google/callback`.
4. Generate local secrets:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Use the hex value for `SESSION_SECRET` and the base64 value for `TOKEN_ENCRYPTION_KEY`.

```bash
npm install
npm run db:up
npm run db:generate
npm run db:migrate
npm run web:dev
```

`db:up` uses the included Docker Compose PostgreSQL service (Docker Desktop or Docker Engine with Compose is required). Skip it if `DATABASE_URL` points to an existing PostgreSQL instance. `npm run db:down` stops the development database without deleting its named volume.

`npm run web:dev` starts the API, durable worker, and Vite frontend together. For production, build the UI with `npm run frontend:build`, run migrations with `npm run db:deploy`, and run `npm run web` plus `npm run worker` as separate processes behind HTTPS.

Production startup rejects non-HTTPS or loopback API, web, and OAuth callback URLs. `GET /api/health` is a lightweight liveness endpoint; `GET /api/ready` validates runtime configuration, database connectivity, and a recent worker heartbeat in production.

Before opening the service to the public, publish the Google OAuth consent screen and complete any brand/sensitive-scope verification Google requires for the YouTube scope. Large-scale operation will also require a YouTube API quota audit/extension.

### Controlled staging checklist

Staging must use its own empty Supabase project/database and its own provider OAuth clients. Never point staging at the development or production database. For a persistent Node server, copy the appropriate direct or session-pooler connection string from Supabase's **Connect** panel; use a connection suitable for Prisma migrations and long-running server processes.

1. Create a dedicated Supabase project for staging and keep its project reference separate from production.
2. Copy `.env.example` into the staging platform's secret store. Set `NODE_ENV=production`, `APP_ENV=staging`, the staging `DATABASE_URL`, and `STAGING_DATABASE_IDENTIFIER` to the unique staging project reference found in the database username, hostname, or name. Set `MIGRATION_MAX_TRACKS=3` for controlled validation.
3. Configure unique staging values for `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY`, plus the Spotify and Google client IDs/secrets. Do not commit a populated environment file.
4. Apply the committed Prisma migrations non-interactively. This applies the web-app, Phase 1 fencing/phase, Phase 2 reliability, and Phase 3 staging migrations in deterministic directory order; it does not reset or generate destructive development migrations:

   ```bash
   npm ci
   npm run db:generate
   npm run db:deploy
   npm run db:status
   ```

5. Register the exact staging Spotify callback: `https://<staging-api-host>/api/auth/spotify/callback`, then set the same value in `SPOTIFY_WEB_REDIRECT_URI`.
6. Register the exact staging Google web callback: `https://<staging-api-host>/api/auth/google/callback`, then set the same value in `GOOGLE_REDIRECT_URI`. Keep offline access and the existing PKCE/state checks enabled.
7. Build the frontend with `npm run frontend:build`.
8. Start the API with `npm run web`.
9. Start the separate durable worker with `npm run worker`.
10. Confirm `GET https://<staging-api-host>/api/health` returns `{"ok":true}`.
11. Confirm `GET https://<staging-api-host>/api/ready` returns HTTP 200 with configuration, database, and worker checks all true.
12. Run `npm run staging:preflight`. It validates staging identity, required configuration, database connectivity, all committed Prisma migrations, the worker heartbeat, and both health endpoints without printing secret values.
13. Connect the dedicated test Spotify account and confirm the UI reports its connection state.
14. Connect the dedicated test Google/YouTube account and confirm the UI reports its connection state.
15. Select **1 track**, run the scan, and confirm preview/review causes no YouTube mutation before pressing **Start migration**.
16. Start the migration, verify the expected YouTube like, and inspect the structured operation logs.
17. Select **3 tracks** and repeat. The server-side `MIGRATION_MAX_TRACKS=3` guard rejects a larger request even if a client is modified.
18. During the controlled run, test pause/resume, close and refresh the browser, and disconnect/reconnect the SSE connection. Confirm the UI converges to PostgreSQL state.
19. Inspect logs for migration/track IDs, operation, retry, duration, and result classification. Confirm no tokens, authorization codes, cookies, headers, client secrets, encryption keys, or provider response bodies appear.
20. Inspect the staging PostgreSQL migration, track, connection-health, video-like coordination, and worker-runtime rows. Only after the real integration suite and this checklist pass should production deployment be considered.

[Spotify](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow) and [Google](https://developers.google.com/identity/protocols/oauth2/web-server) require configured redirect URIs to match exactly. Google offline access is required for refresh tokens. [Supabase's Prisma guidance](https://supabase.com/docs/guides/database/prisma) distinguishes direct/session connections for persistent servers and migrations from transaction pooling for serverless workloads.

### Web routes

- `GET /api/health`, `GET /api/ready`
- `GET /api/me`, `GET /api/connections`
- `GET /api/auth/spotify`, `GET /api/auth/spotify/callback`
- `GET /api/auth/google`, `GET /api/auth/google/callback`
- `GET|POST /api/migrations`, `GET /api/migrations/:id`
- `POST /api/migrations/:id/scan|start|pause|resume|retry`
- `GET /api/migrations/:id/tracks|reviews|events`
- `POST /api/migrations/:id/reviews/:trackId/choose|skip|search`
- `DELETE /api/connections/:provider`, `DELETE /api/account`

Every migration and review lookup is scoped to the authenticated user.

## Architecture

- Node.js CLI: orchestration, Spotify OAuth, Spotify pagination, matching, state, logging.
- Python bridge: YouTube Music search and liking through `ytmusicapi`.
- Local data files under `data/`: Spotify token, fetched library, YouTube Music auth, sync state, review items.
- Matcher tests under `test/`: run without Spotify or YouTube Music credentials.

## Requirements

- Node.js 20.19 or newer (or 22.12+). The web build uses Vite 7; Node 24 works.
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

The legacy CLI requires this Spotify scope:

```text
user-library-read
```

Authenticate:

```bash
npm run auth:spotify
```

The token is saved to `data/spotify-token.json`, which is ignored by Git.

## YouTube Music Setup (legacy local CLI only)

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

The following browser-auth fallback is retained only so existing local CLI workflows keep working. It is never used or exposed by the public web application. If local CLI OAuth initializes but authenticated YouTube Music account operations return HTTP 400, the local operator can use:

```bash
npm run auth:ytmusic:browser
```

This creates `data/ytmusic-browser.json` from request headers copied from an active YouTube Music browser session. OAuth remains in `data/ytmusic-oauth.json`, but account operations prefer browser auth when the browser file exists.

The helper asks for these values one at a time:

```text
Accept
Authorization
Content-Type
X-Goog-AuthUser
x-origin
Cookie
```

You can also paste a JSON or `Header: value` block at the first prompt. The setup helper validates those fields, writes the browser auth file, initializes `YTMusic` with it, and performs a read-only account diagnostic.

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

The default suite covers matching, OAuth/PKCE requests, safe account reconnection,
migration state transitions, atomic review/retry behavior, and worker lease fencing.
It does not contact Spotify or YouTube Music.

PostgreSQL integration tests use the real Prisma migrations and transaction
isolation. Point `TEST_DATABASE_URL` at a dedicated database whose name contains
`test`; the suite deletes rows from that database:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/musicmove_test npm run test:integration
```

The integration suite is skipped when `TEST_DATABASE_URL` is not set.

## Security

Never commit `.env`, `.venv/`, `data/`, tokens, cookies, generated YouTube Music auth files, or personal library data. `.gitignore` excludes these by default.

## Current Limitations

- You should inspect `data/review.json` manually before deciding what to do with ambiguous tracks.
- `already_liked` detection depends on the YouTube Music liked-songs list returning the matched video ID.
- YouTube Music behavior comes from the unofficial `ytmusicapi` package and may change with YouTube Music internals.
