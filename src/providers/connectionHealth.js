async function markConnectionHealth(prisma, modelName, connection, status, errorCode = null) {
  if (!connection?.id || !prisma?.[modelName]?.updateMany) return;
  const data = {
    connectionStatus: status,
    lastAuthErrorCode: errorCode,
    authInvalidAt: status === 'ACTIVE' ? null : new Date(),
  };
  await prisma[modelName].updateMany({ where: { id: connection.id }, data });
  Object.assign(connection, data);
}

function ensureConnectionUsable(connection, provider) {
  if (!connection) return;
  if (connection.connectionStatus && connection.connectionStatus !== 'ACTIVE') {
    const error = new Error(`${provider} needs to be connected again.`);
    error.name = 'ProviderError';
    error.provider = provider;
    error.code = connection.lastAuthErrorCode || 'RECONNECT_REQUIRED';
    error.authenticationRequired = true;
    throw error;
  }
}

function connectionState(connection, now = new Date()) {
  if (!connection) return { connected: false, usable: false, status: 'not_connected', reconnectRequired: false };
  const expired = Boolean(connection.expiresAt && connection.expiresAt <= now);
  const health = connection.connectionStatus || 'ACTIVE';
  const status = health === 'AUTHENTICATION_INVALID'
    ? 'authentication_invalid'
    : health === 'RECONNECT_REQUIRED' || (expired && !connection.encryptedRefreshToken)
      ? 'reconnect_required'
      : expired ? 'expired_refreshable' : 'connected';
  const usable = ['connected', 'expired_refreshable'].includes(status);
  return { connected: true, usable, status, reconnectRequired: !usable };
}

module.exports = { markConnectionHealth, ensureConnectionUsable, connectionState };
