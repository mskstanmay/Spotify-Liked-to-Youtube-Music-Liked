function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries(fn, options = {}) {
  const {
    retries = 3,
    baseDelayMs = 500,
    shouldRetry = () => true,
    onRetry = () => {},
  } = options;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !shouldRetry(error)) break;
      const delay = baseDelayMs * (2 ** attempt);
      onRetry(error, attempt + 1, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

module.exports = { sleep, withRetries };
