const { spawn } = require('node:child_process');
const readline = require('node:readline/promises');
const path = require('node:path');
const config = require('./config');
const { authenticateSpotify } = require('./spotify/auth');
const { fetchAllLikedSongs } = require('./spotify/likedSongs');
const { syncLibrary, showReview } = require('./sync/sync');
const ytmusic = require('./ytmusic/client');
const { matchTrack } = require('./matching/trackMatcher');
const { pythonExecutable } = require('./ytmusic/client');
const { ensureDir, exists, readJson } = require('./utils/files');

function usage() {
  process.stdout.write(`
Spotify -> YouTube Music Liked Songs

Commands:
  npm start                 Run the normal sync
  npm run auth:spotify      Authenticate Spotify
  npm run auth:ytmusic      Create data/ytmusic-oauth.json with ytmusicapi
  npm run auth:ytmusic:browser
  npm run fetch             Fetch Spotify liked songs only
  npm run match             Search and match without liking
  npm run sync              Run synchronization
  npm run retry             Retry failed tracks
  npm run review            Show tracks requiring review
  node src/index.js trace-track --title "Song title"
  node src/index.js auth:ytmusic:diag
  node src/index.js auth:ytmusic:like-test

Options:
  --force                   Re-fetch Spotify data and rebuild sync state
  --refresh-spotify         Re-fetch Spotify library before running
  --dry-run                 Search and match without liking
  --limit N                 Process only N tracks
  --from-index N            Start at 1-based Spotify library index N
`);
}

function ytmusicDiagnosticFailure(error) {
  if (error?.payload?.exception?.authFailure || error?.httpStatus === 401) {
    return `AUTHENTICATION FAILURE ${error.message}`;
  }
  if (error?.httpStatus === 400 || String(error?.message || '').includes('HTTP 400')) {
    return `YOUTUBE MUSIC API FAILURE ${error.message}`;
  }
  return `FAILED ${error.message}`;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return '';
  return process.argv[index + 1] || '';
}

function numberOption(name) {
  const raw = optionValue(name);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function runWithInput(command, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'inherit', 'inherit'], ...options });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
    child.stdin.end(input);
  });
}

function looksLikeHeaderBlock(value) {
  return /^\s*\{/.test(value) || /^[A-Za-z-]+:\s*/m.test(value);
}

function parseHeaderBlockLocally(raw) {
  const text = raw.trim();
  if (!text) return {};
  if (text.startsWith('{')) {
    const parsed = JSON.parse(text);
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key.toLowerCase(), String(value).trim()]));
  }

  const headers = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) headers[match[1].trim().toLowerCase()] = match[2].trim();
  }
  return headers;
}

async function promptBrowserHeaders() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write('Press Enter at the first prompt to enter each value one-by-one.\n');
    const first = await rl.question('Accept or pasted header block: ');
    if (looksLikeHeaderBlock(first)) {
      const lines = [first];
      process.stdout.write('Paste any remaining header lines now. Submit an empty line when done.\n');
      while (true) {
        const line = await rl.question('');
        if (!line.trim()) break;
        lines.push(line);
      }
      return parseHeaderBlockLocally(lines.join('\n'));
    }

    const headers = { accept: first.trim() };
    headers.authorization = (await rl.question('Authorization: ')).trim();
    headers['content-type'] = (await rl.question('Content-Type: ')).trim();
    headers['x-goog-authuser'] = (await rl.question('X-Goog-AuthUser: ')).trim();
    headers['x-origin'] = (await rl.question('x-origin: ')).trim();
    headers.cookie = (await rl.question('Cookie: ')).trim();
    return headers;
  } finally {
    rl.close();
  }
}

function ytmusicapiExecutable() {
  return process.platform === 'win32'
    ? path.join(config.rootDir, '.venv', 'Scripts', 'ytmusicapi.exe')
    : path.join(config.rootDir, '.venv', 'bin', 'ytmusicapi');
}

async function authYtmusic() {
  const python = pythonExecutable();
  if (!(await exists(python))) {
    throw new Error('Create the virtual environment first: python -m venv .venv && .venv\\Scripts\\python -m pip install -r requirements.txt');
  }
  const ytmusicapi = ytmusicapiExecutable();
  if (!(await exists(ytmusicapi))) {
    throw new Error('ytmusicapi is not installed in .venv. Run .venv\\Scripts\\python -m pip install -r requirements.txt');
  }

  await ensureDir(config.dataDir);
  process.stdout.write('Starting ytmusicapi OAuth setup. Follow the prompts in this terminal.\n');
  const args = ['oauth', '--file', config.ytmusic.authPath];
  if (config.ytmusic.clientId) args.push('--client-id', config.ytmusic.clientId);
  if (config.ytmusic.clientSecret) args.push('--client-secret', config.ytmusic.clientSecret);
  await run(ytmusicapi, args, { cwd: config.rootDir });
  process.stdout.write(`YouTube Music auth saved under ${config.ytmusic.authPath}\n`);
}

async function authYtmusicBrowser() {
  const python = pythonExecutable();
  if (!(await exists(python))) {
    throw new Error('Create the virtual environment first: python -m venv .venv && .venv\\Scripts\\python -m pip install -r requirements.txt');
  }

  await ensureDir(config.dataDir);
  process.stdout.write(`This will create ${config.ytmusic.browserAuthPath}\n`);
  process.stdout.write('In Chrome/Edge:\n');
  process.stdout.write('1. Open https://music.youtube.com and make sure you are logged in.\n');
  process.stdout.write('2. Open DevTools -> Network.\n');
  process.stdout.write('3. Filter for /browse and click a successful POST /youtubei/v1/browse request.\n');
  process.stdout.write('4. Enter these values at the prompts, or paste a JSON/raw header block at the first prompt:\n');
  process.stdout.write('   Accept, Authorization, Content-Type, X-Goog-AuthUser, x-origin, Cookie\n');
  process.stdout.write('Values are never printed by this helper.\n\n');

  const headers = await promptBrowserHeaders();
  await runWithInput(python, [
    path.join(config.rootDir, 'src', 'ytmusic', 'like_song.py'),
    '--auth',
    config.ytmusic.authPath,
    '--browser-auth',
    config.ytmusic.browserAuthPath,
    '--trace',
    'setup-browser',
    '--output',
    config.ytmusic.browserAuthPath,
  ], `${JSON.stringify(headers)}\n`, { cwd: config.rootDir });
}

async function traceTrack() {
  const title = optionValue('--title');
  const id = optionValue('--id');
  if (!title && !id) {
    throw new Error('Provide --title or --id for trace-track.');
  }

  const library = await readJson(config.spotify.libraryPath, null);
  if (!library?.tracks?.length) {
    throw new Error('Cached Spotify library not found. Run npm run fetch first.');
  }

  const normalizedTitle = title.toLowerCase();
  const track = library.tracks.find((item) => (
    (id && item.spotifyTrackId === id)
    || (title && String(item.title || '').toLowerCase() === normalizedTitle)
  ));

  if (!track) {
    throw new Error(`Track not found in cached Spotify library: ${title || id}`);
  }

  process.stdout.write('Trace target:\n');
  process.stdout.write(JSON.stringify({
    spotifyTrackId: track.spotifyTrackId,
    title: track.title,
    artists: track.artists,
    album: track.album,
    durationMs: track.durationMs,
  }, null, 2));
  process.stdout.write('\n\n');

  process.stdout.write('Node -> YouTube Music bridge -> ytmusicapi search\n');
  const filters = optionValue('--yt-filters');
  const payload = await ytmusic.traceSearchTrack(track, { filters });
  const candidates = payload.results || [];
  process.stdout.write(`Search returned ${candidates.length} candidates.\n`);

  const match = matchTrack(track, candidates, { threshold: config.sync.confidenceThreshold });
  process.stdout.write('Matcher result:\n');
  process.stdout.write(JSON.stringify({
    matched: match.matched,
    videoId: match.videoId,
    title: match.title,
    artists: match.artists,
    score: match.score,
    confidence: match.confidence,
    reason: match.reason,
    candidateCount: match.candidates.length,
  }, null, 2));
  process.stdout.write('\n');

  process.stdout.write('\nLiked-song lookup: not executed by npm run match / dry-run.\n');
  process.stdout.write('rate_song / like operation: not executed by npm run match / dry-run.\n');
}

async function authYtmusicDiagnostic() {
  process.stdout.write('AUTH INIT:\n');
  const init = await ytmusic.authInitDiagnostic();
  process.stdout.write(`${JSON.stringify(init, null, 2)}\n\n`);

  process.stdout.write('ACCOUNT INFO READ:\n');
  try {
    const info = await ytmusic.accountInfoDiagnostic();
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n\n`);
  } catch (error) {
    process.stdout.write(`${ytmusicDiagnosticFailure(error)}\n\n`);
  }

  process.stdout.write('LIKED SONGS READ:\n');
  try {
    const liked = await ytmusic.likedSongsDiagnostic(5);
    process.stdout.write(`${JSON.stringify({
      ok: liked.ok,
      count: liked.count,
      requestCount: liked.requests?.length || 0,
      requests: liked.requests,
    }, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${ytmusicDiagnosticFailure(error)}\n`);
  }
}

async function authYtmusicLikeTest() {
  const videoId = 'znvky0Uq8qc';
  process.stdout.write('ONE-TRACK LIKE TEST\n');
  process.stdout.write('Track: Until I Found You - Stephen Sanchez\n');
  process.stdout.write(`Video ID: ${videoId}\n`);
  process.stdout.write('Using browser authentication only.\n\n');

  const result = await ytmusic.likeAndVerifyTrack(videoId, config.ytmusic.likedSongsLimit);
  process.stdout.write(`${JSON.stringify({
    ok: result.ok,
    videoId: result.videoId,
    rateSong: result.rateSong,
    verification: result.verification,
    verified: result.verified,
    checkedLikedSongs: result.checkedLikedSongs,
    requestCount: result.requests?.length || 0,
    requests: result.requests,
  }, null, 2)}\n`);

  if (!result.verified) {
    throw new Error(`rate_song returned OK, but ${videoId} was not found in liked songs verification.`);
  }

  process.stdout.write('Single-track browser-authenticated LIKE test passed.\n');
}

async function main() {
  const command = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'sync';

  if (['help', '--help', '-h'].includes(command)) {
    usage();
    return;
  }

  if (command === 'auth:spotify') {
    await authenticateSpotify();
    process.stdout.write('Spotify authentication saved.\n');
    return;
  }

  if (command === 'auth:ytmusic') {
    await authYtmusic();
    return;
  }

  if (command === 'auth:ytmusic:browser') {
    await authYtmusicBrowser();
    return;
  }

  if (command === 'auth:ytmusic:diag') {
    await authYtmusicDiagnostic();
    return;
  }

  if (command === 'auth:ytmusic:like-test') {
    await authYtmusicLikeTest();
    return;
  }

  if (command === 'fetch') {
    await fetchAllLikedSongs({
      persist: true,
      onProgress: (count, total) => process.stdout.write(`Fetched ${count}/${total || '?'} Spotify tracks...\n`),
    });
    return;
  }

  if (command === 'match') {
    await syncLibrary({
      dryRun: true,
      refreshSpotify: hasFlag('--refresh-spotify'),
      force: hasFlag('--force'),
      limit: numberOption('--limit'),
      fromIndex: numberOption('--from-index'),
    });
    return;
  }

  if (command === 'retry') {
    await syncLibrary({
      retryFailed: true,
      refreshSpotify: hasFlag('--refresh-spotify'),
      limit: numberOption('--limit'),
      fromIndex: numberOption('--from-index'),
    });
    return;
  }

  if (command === 'review') {
    await showReview();
    return;
  }

  if (command === 'trace-track') {
    await traceTrack();
    return;
  }

  if (command === 'sync') {
    await syncLibrary({
      force: hasFlag('--force'),
      refreshSpotify: hasFlag('--refresh-spotify'),
      dryRun: hasFlag('--dry-run'),
      limit: numberOption('--limit'),
      fromIndex: numberOption('--from-index'),
    });
    return;
  }

  throw new Error(`Unknown command: ${command}. Run npm start -- help.`);
}

main().catch((error) => {
  process.stderr.write(`FAILED ${error.message}\n`);
  process.exitCode = 1;
});
