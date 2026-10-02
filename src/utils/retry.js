function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries(fn, options = {}) {
  const {
    retries = 3,
    baseDelayMs = 500,
    shouldRetry = () => true,
    onRetry = () => {},
    maxDelayMs = 60_000,
    sleepFn = sleep,
  } = options;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !shouldRetry(error)) break;
      const exponentialDelay = baseDelayMs * (2 ** attempt);
      const requestedDelay = Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : exponentialDelay;
      const delay = Math.max(0, Math.min(requestedDelay, maxDelayMs));
      onRetry(error, attempt + 1, delay);
      await sleepFn(delay);
    }
  }
  throw lastError;
}

module.exports = { sleep, withRetries };
