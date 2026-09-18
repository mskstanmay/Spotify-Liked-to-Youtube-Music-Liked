const { spawn } = require('node:child_process');
const path = require('node:path');
const config = require('./config');
const { authenticateSpotify } = require('./spotify/auth');
const { fetchAllLikedSongs } = require('./spotify/likedSongs');
const { syncLibrary, showReview } = require('./sync/sync');
const { pythonExecutable } = require('./ytmusic/client');
const { ensureDir, exists } = require('./utils/files');

function usage() {
  process.stdout.write(`
Spotify -> YouTube Music Liked Songs

Commands:
  npm start                 Run the normal sync
  npm run auth:spotify      Authenticate Spotify
  npm run auth:ytmusic      Create data/ytmusic-oauth.json with ytmusicapi
  npm run fetch             Fetch Spotify liked songs only
  npm run match             Search and match without liking
  npm run sync              Run synchronization
  npm run retry             Retry failed tracks
  npm run review            Show tracks requiring review

Options:
  --force                   Re-fetch Spotify data and rebuild sync state
  --refresh-spotify         Re-fetch Spotify library before running
  --dry-run                 Search and match without liking
`);
}

function hasFlag(name) {
  return process.argv.includes(name);
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

  if (command === 'fetch') {
    await fetchAllLikedSongs({
      persist: true,
      onProgress: (count, total) => process.stdout.write(`Fetched ${count}/${total || '?'} Spotify tracks...\n`),
    });
    return;
  }

  if (command === 'match') {
    await syncLibrary({ dryRun: true, refreshSpotify: hasFlag('--refresh-spotify'), force: hasFlag('--force') });
    return;
  }

  if (command === 'retry') {
    await syncLibrary({ retryFailed: true, refreshSpotify: hasFlag('--refresh-spotify') });
    return;
  }

  if (command === 'review') {
    await showReview();
    return;
  }

  if (command === 'sync') {
    await syncLibrary({
      force: hasFlag('--force'),
      refreshSpotify: hasFlag('--refresh-spotify'),
      dryRun: hasFlag('--dry-run'),
    });
    return;
  }

  throw new Error(`Unknown command: ${command}. Run npm start -- help.`);
}

main().catch((error) => {
  process.stderr.write(`FAILED ${error.message}\n`);
  process.exitCode = 1;
});
