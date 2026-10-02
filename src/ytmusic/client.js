const { spawn } = require('node:child_process');
const path = require('node:path');
const config = require('../config');
const { exists } = require('../utils/files');

const SERVER_ONLY_ENV = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'TOKEN_ENCRYPTION_KEY',
  'SPOTIFY_CLIENT_SECRET',
  'GOOGLE_CLIENT_SECRET',
];

class PythonBridgeError extends Error {
  constructor(message, { code, retryable = false } = {}) {
    super(message);
    this.name = 'PythonBridgeError';
    this.code = code;
    this.retryable = retryable;
  }
}

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

async function runPython(args, options = {}) {
  const python = await (options.ensurePythonReadyImpl || ensurePythonReady)();
  return new Promise((resolve, reject) => {

    const fullArgs = [
      path.join(config.rootDir, 'src', 'ytmusic', 'like_song.py'),
      '--auth',
      config.ytmusic.authPath,
      '--browser-auth',
      config.ytmusic.browserAuthPath,
      ...(options.trace ? ['--trace'] : []),
      ...args,
    ];

    const childEnv = { ...process.env };
    for (const name of SERVER_ONLY_ENV) delete childEnv[name];
    if (args[0] === 'search') {
      delete childEnv.YTMUSIC_CLIENT_ID;
      delete childEnv.YTMUSIC_CLIENT_SECRET;
    }
    const spawnImpl = options.spawnImpl || spawn;
    let child;
    try {
      child = spawnImpl(python, fullArgs, {
        cwd: config.rootDir,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = options.timeoutMs ?? config.ytmusic.subprocessTimeoutMs;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new PythonBridgeError('The YouTube Music operation timed out and can be retried.', { code: 'PYTHON_TIMEOUT', retryable: true }));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (options.forwardStderr) process.stderr.write(chunk);
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (settled) return;
      const text = stdout.trim();
      let payload;
      try {
        payload = text ? JSON.parse(text.split(/\r?\n/).at(-1)) : {};
      } catch (error) {
        finish(reject, new PythonBridgeError('Could not parse the YouTube Music bridge response.', { code: 'PYTHON_INVALID_RESPONSE', retryable: true }));
        return;
      }

      if (code !== 0 || payload.ok === false) {
        const error = new Error(payload.error || stderr.trim() || `YouTube Music bridge exited with code ${code}`);
        error.payload = payload;
        error.code = code;
        if (payload.exception?.httpStatus) error.httpStatus = payload.exception.httpStatus;
        finish(reject, error);
        return;
      }
      finish(resolve, payload);
    });
  });
}

function searchTrack(track) {
  const query = `${track.title} ${track.artists.join(' ')}`.trim();
  return runPython(['search', '--query', query, '--limit', String(config.ytmusic.searchLimit)])
    .then((payload) => payload.results || []);
}

function likeTrack(videoId) {
  return runPython(['like', `--video-id=${videoId}`]);
}

function likeAndVerifyTrack(videoId, verifyLimit = 10000) {
  return runPython(['like-verify', `--video-id=${videoId}`, '--verify-limit', String(verifyLimit)], {
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

function likeArgumentDiagnostic(videoId) {
  return runPython(['echo-video-id', `--video-id=${videoId}`]);
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
  likeArgumentDiagnostic,
  traceSearchTrack,
  PythonBridgeError,
};
