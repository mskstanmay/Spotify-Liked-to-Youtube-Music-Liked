const config = require('../config');

function line(message = '') {
  process.stdout.write(`${message}\n`);
}

function debug(message, detail) {
  if (!config.sync.debug) return;
  line(`[debug] ${message}`);
  if (detail !== undefined) line(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
}

module.exports = {
  line,
  debug,
  success: (message) => line(`SUCCESS ${message}`),
  skipped: (message) => line(`SKIPPED ${message}`),
  review: (message) => line(`REVIEW ${message}`),
  failed: (message) => line(`FAILED ${message}`),
};
