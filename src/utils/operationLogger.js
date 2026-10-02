const SAFE_FIELDS = new Set([
  'migrationId', 'trackId', 'phase', 'workerId', 'operation', 'provider',
  'retryNumber', 'durationMs', 'result', 'reason', 'videoId', 'trackCount',
]);

function operationEvent(fields, now = new Date()) {
  const event = { event: 'provider_operation', timestamp: now.toISOString() };
  for (const [key, value] of Object.entries(fields || {})) {
    if (!SAFE_FIELDS.has(key) || value === undefined || value === null) continue;
    if (['string', 'number', 'boolean'].includes(typeof value)) event[key] = value;
  }
  return event;
}

function logOperation(logger, level, fields) {
  const write = logger?.[level] || logger?.info;
  if (typeof write !== 'function') return;
  write.call(logger, JSON.stringify(operationEvent(fields)));
}

module.exports = { SAFE_FIELDS, operationEvent, logOperation };
