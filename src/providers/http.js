const MAX_RETRY_AFTER_MS = 60_000;
const DAILY_QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded', 'dailyLimitExceededUnreg', 'variableTermExpiredDailyExceeded']);
const TRANSIENT_RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'userRateLimitExceededUnreg', 'servingLimitExceeded', 'concurrentLimitExceeded', 'uploadRateLimitExceeded']);

class ProviderError extends Error {
  constructor(message, { provider, status, code, retryable = false, authenticationRequired = false, quotaExceeded = false, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.authenticationRequired = authenticationRequired;
    this.quotaExceeded = quotaExceeded;
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfterMs(response, maximum = MAX_RETRY_AFTER_MS) {
  const raw = response.headers?.get?.('retry-after');
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw.trim())) return null;
  const milliseconds = Math.ceil(Number(raw) * 1000);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  return Math.min(milliseconds, maximum);
}

function errorReason(body) {
  const error = body?.error;
  return error?.errors?.[0]?.reason
    || error?.reason
    || (typeof error?.status === 'string' ? error.status : null)
    || (typeof error === 'string' ? error : null)
    || 'provider_error';
}

async function jsonResponse(response, provider) {
  const body = await response.json().catch(() => ({}));
  if (response.ok) return body;
  const reason = errorReason(body);
  const dailyQuota = provider === 'YouTube' && DAILY_QUOTA_REASONS.has(reason);
  const transientRateLimit = response.status === 429 || TRANSIENT_RATE_REASONS.has(reason);
  throw new ProviderError(`${provider} request failed.`, {
    provider,
    status: response.status,
    code: String(reason),
    retryable: !dailyQuota && (transientRateLimit || response.status >= 500),
    authenticationRequired: response.status === 401 || reason === 'invalid_grant',
    quotaExceeded: dailyQuota,
    retryAfterMs: retryAfterMs(response),
  });
}

async function providerFetch(url, options, provider) {
  try {
    return await fetch(url, options);
  } catch (error) {
    throw new ProviderError(`${provider} is temporarily unavailable.`, {
      provider,
      code: error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR',
      retryable: true,
    });
  }
}

module.exports = { ProviderError, jsonResponse, providerFetch, retryAfterMs, errorReason, MAX_RETRY_AFTER_MS };
