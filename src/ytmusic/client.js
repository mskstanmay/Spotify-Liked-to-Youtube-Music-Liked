const { spawn } = require('node:child_process');
const path = require('node:path');
const config = require('../config');
const { exists } = require('../utils/files');

function pythonExecutable() {
  return process.platform === 'win32'
    ? path.join(config.rootDir, '.venv', 'Scripts', 'python.exe')
    : path.join(config.rootDir, '.venv', 'bin', 'python');
}

async function ensurePythonReady() {
  const python = pythonExecutable();
  if (!(await exists(python))) {
    throw new Error(`Python virtual environment not found. Create it first: python -m venv .venv`);
  }
  return python;
}

function runPython(args, options = {}) {
  return new Promise(async (resolve, reject) => {
    let python;
    try {
      python = await ensurePythonReady();
    } catch (error) {
      reject(error);
      return;
    }

    const fullArgs = [
      path.join(config.rootDir, 'src', 'ytmusic', 'like_song.py'),
      '--auth',
      config.ytmusic.authPath,
      '--browser-auth',
      config.ytmusic.browserAuthPath,
      '--client-id',
      config.ytmusic.clientId,
      '--client-secret',
      config.ytmusic.clientSecret,
      ...(options.trace ? ['--trace'] : []),
      ...args,
    ];

    const child = spawn(python, fullArgs, {
      cwd: config.rootDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (options.forwardStderr) process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const text = stdout.trim();
      let payload;
      try {
        payload = text ? JSON.parse(text.split(/\r?\n/).at(-1)) : {};
      } catch (error) {
        reject(new Error(`Could not parse YouTube Music response. stderr=${stderr.trim()} stdout=${stdout.trim()}`));
        return;
      }

      if (code !== 0 || payload.ok === false) {
        reject(new Error(payload.error || stderr.trim() || `YouTube Music bridge exited with code ${code}`));
        return;
      }
      resolve(payload);
    });
  });
}

function searchTrack(track) {
  const query = `${track.title} ${track.artists.join(' ')}`.trim();
  return runPython(['search', '--query', query, '--limit', String(config.ytmusic.searchLimit)])
    .then((payload) => payload.results || []);
}

function likeTrack(videoId) {
  return runPython(['like', '--video-id', videoId]);
}

function likeAndVerifyTrack(videoId, verifyLimit = 10000) {
  return runPython(['like-verify', '--video-id', videoId, '--verify-limit', String(verifyLimit)], {
    trace: true,
    forwardStderr: true,
  });
}

function getLikedVideoIds() {
  return runPython(['liked-ids', '--limit', String(config.ytmusic.likedSongsLimit)])
    .then((payload) => new Set(payload.videoIds || []));
}

function authInitDiagnostic() {
  return runPython(['auth-init'], {
    trace: true,
    forwardStderr: true,
  });
}

function accountInfoDiagnostic() {
  return runPython(['account-info'], {
    trace: true,
    forwardStderr: true,
  });
}

function likedSongsDiagnostic(limit = 25) {
  return runPython(['liked-ids', '--limit', String(limit)], {
    trace: true,
    forwardStderr: true,
  });
}

function traceSearchTrack(track, options = {}) {
  const query = `${track.title} ${track.artists.join(' ')}`.trim();
  const args = ['search', '--query', query, '--limit', String(config.ytmusic.searchLimit)];
  if (options.filters) args.push('--filters', options.filters);
  return runPython(args, {
    trace: true,
    forwardStderr: true,
  });
}

module.exports = {
  pythonExecutable,
  runPython,
  searchTrack,
  likeTrack,
  likeAndVerifyTrack,
  getLikedVideoIds,
  authInitDiagnostic,
  accountInfoDiagnostic,
  likedSongsDiagnostic,
  traceSearchTrack,
};
