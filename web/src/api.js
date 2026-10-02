let csrfToken = '';

export function setCsrfToken(value) {
  csrfToken = value || '';
}

export async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.body && typeof options.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    options = { ...options, body: JSON.stringify(options.body) };
  }
  if (!['GET', 'HEAD'].includes(method.toUpperCase()) && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const response = await fetch(`/api${path}`, { ...options, method, headers, credentials: 'include' });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error?.message || 'Something went wrong.');
    error.code = body.error?.code;
    error.status = response.status;
    throw error;
  }
  return body;
}

export function providerUrl(provider, returnTo = '/connections') {
  return `/api/auth/${provider}?returnTo=${encodeURIComponent(returnTo)}`;
}
