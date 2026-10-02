function migrationEventId(migration) {
  return new Date(migration.updatedAt).toISOString();
}

function shouldSendMigration(lastEventId, migration) {
  return migrationEventId(migration) !== String(lastEventId || '');
}

function migrationEvent(migration) {
  return `id: ${migrationEventId(migration)}\nevent: migration\ndata: ${JSON.stringify(migration)}\n\n`;
}

module.exports = { migrationEventId, shouldSendMigration, migrationEvent };
