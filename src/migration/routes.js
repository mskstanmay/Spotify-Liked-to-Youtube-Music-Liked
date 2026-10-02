const { z } = require('zod');
const ytmusic = require('../ytmusic/client');
const { matchTrack } = require('../matching/trackMatcher');
const { migrationJson, trackJson } = require('./serialize');
const { countMigrationTracks } = require('./state');
const { migrationEventId, shouldSendMigration, migrationEvent } = require('./sse');
const { connectionState } = require('../providers/connectionHealth');

const listQuery = z.object({
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const createMigrationBody = z.object({
  trackLimit: z.number().int().min(1).max(10_000).nullable().optional(),
}).strict();

async function ownedMigration(prisma, userId, id, include = undefined) {
  return prisma.migration.findFirst({ where: { id, userId }, include });
}

function notFound(reply) {
  return reply.code(404).send({ error: { code: 'MIGRATION_NOT_FOUND', message: 'Migration not found.' } });
}

function transitionConflict(reply, message = 'The migration changed while this request was being processed.') {
  return reply.code(409).send({ error: { code: 'MIGRATION_STATE_CHANGED', message } });
}

async function updateOwnedMigration(prisma, migration, userId, data) {
  const changed = await prisma.migration.updateMany({
    where: {
      id: migration.id,
      userId,
      status: migration.status,
      phase: migration.phase,
      leaseVersion: migration.leaseVersion,
    },
    data,
  });
  return changed.count ? prisma.migration.findUnique({ where: { id: migration.id } }) : null;
}

function routeError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

async function serializableTransaction(prisma, callback, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await prisma.$transaction(callback, { isolationLevel: 'Serializable' });
    } catch (error) {
      if (error.code !== 'P2034' || attempt === attempts) throw error;
    }
  }
  throw new Error('Serializable transaction retry exhausted.');
}

function registerMigrationRoutes(app, { prisma, guards, config }) {
  app.get('/api/migrations', { preHandler: guards.required }, async (request) => {
    const migrations = await prisma.migration.findMany({ where: { userId: request.user.id }, orderBy: { createdAt: 'desc' } });
    return { migrations: migrations.map(migrationJson) };
  });

  app.post('/api/migrations', { preHandler: guards.csrf }, async (request, reply) => {
    const spotifyConnection = await prisma.spotifyConnection.findUnique({ where: { userId: request.user.id } });
    if (!spotifyConnection) return reply.code(409).send({ error: { code: 'SPOTIFY_NOT_CONNECTED', message: 'Connect Spotify before creating a migration.' } });
    if (!connectionState(spotifyConnection).usable) return reply.code(409).send({ error: { code: 'SPOTIFY_RECONNECT_REQUIRED', message: 'Reconnect Spotify before creating a migration.' } });
    const parsed = createMigrationBody.safeParse(request.body || {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_TRACK_LIMIT', message: 'Choose a valid migration track limit.' } });
    const requestedLimit = parsed.data.trackLimit || null;
    if (config.migrationMaxTracks && requestedLimit && requestedLimit > config.migrationMaxTracks) {
      return reply.code(400).send({ error: { code: 'TRACK_LIMIT_EXCEEDED', message: `This environment allows at most ${config.migrationMaxTracks} tracks per migration.` } });
    }
    const trackLimit = requestedLimit || config.migrationMaxTracks || null;
    const migration = await prisma.migration.create({ data: { userId: request.user.id, ...(trackLimit ? { trackLimit } : {}) } });
    return reply.code(201).send({ migration: migrationJson(migration) });
  });

  app.get('/api/migrations/:id', { preHandler: guards.required }, async (request, reply) => {
    const migration = await ownedMigration(prisma, request.user.id, request.params.id);
    return migration ? { migration: migrationJson(migration) } : notFound(reply);
  });

  app.post('/api/migrations/:id/scan', { preHandler: guards.csrf }, async (request, reply) => {
    const migration = await ownedMigration(prisma, request.user.id, request.params.id);
    if (!migration) return notFound(reply);
    if (!['DRAFT', 'FAILED', 'AUTHENTICATION_REQUIRED'].includes(migration.status)
      || (migration.status !== 'DRAFT' && migration.phase !== 'SCANNING')) {
      return reply.code(409).send({ error: { code: 'INVALID_MIGRATION_STATE', message: 'This migration cannot be scanned in its current state.' } });
    }
    const updated = await updateOwnedMigration(prisma, migration, request.user.id, {
      status: 'SCANNING', phase: 'SCANNING', processedTracks: 0,
      lastErrorCode: null, lastErrorMessage: null, completedAt: null,
      workerId: null, lockedUntil: null, leaseVersion: { increment: 1 },
    });
    if (!updated) return transitionConflict(reply);
    return reply.code(202).send({ migration: migrationJson(updated) });
  });

  app.post('/api/migrations/:id/start', { preHandler: guards.csrf }, async (request, reply) => {
    const migration = await ownedMigration(prisma, request.user.id, request.params.id);
    if (!migration) return notFound(reply);
    const youtubeConnection = await prisma.youTubeConnection.findUnique({ where: { userId: request.user.id } });
    if (!youtubeConnection) return reply.code(409).send({ error: { code: 'YOUTUBE_NOT_CONNECTED', message: 'Connect YouTube Music before starting.' } });
    if (!connectionState(youtubeConnection).usable) return reply.code(409).send({ error: { code: 'YOUTUBE_RECONNECT_REQUIRED', message: 'Reconnect YouTube Music before starting.' } });
    if (migration.status !== 'READY' || migration.phase !== 'LIKING') {
      return reply.code(409).send({ error: { code: 'INVALID_MIGRATION_STATE', message: 'This migration is not ready to start.' } });
    }
    const updated = await updateOwnedMigration(prisma, migration, request.user.id, {
      status: 'QUEUED', processedTracks: migration.reviewCount + migration.notFoundCount + migration.failedCount + migration.skippedCount,
      startedAt: migration.startedAt || new Date(), completedAt: null,
      lastErrorCode: null, lastErrorMessage: null,
      workerId: null, lockedUntil: null, leaseVersion: { increment: 1 },
    });
    if (!updated) return transitionConflict(reply);
    return reply.code(202).send({ migration: migrationJson(updated) });
  });

  app.post('/api/migrations/:id/pause', { preHandler: guards.csrf }, async (request, reply) => {
    const migration = await ownedMigration(prisma, request.user.id, request.params.id);
    if (!migration) return notFound(reply);
    if (!['SCANNING', 'QUEUED', 'RUNNING'].includes(migration.status)) return reply.code(409).send({ error: { code: 'INVALID_MIGRATION_STATE', message: 'Only an active migration can be paused.' } });
    const updated = await updateOwnedMigration(prisma, migration, request.user.id, {
      // Keep lockedUntil as a drain barrier for an already-started provider
      // request. The fence is invalid immediately, but a replacement worker
      // cannot claim until the old request's bounded timeout has elapsed.
      status: 'PAUSED', workerId: null, leaseVersion: { increment: 1 },
    });
    if (!updated) return transitionConflict(reply);
    return { migration: migrationJson(updated) };
  });

  app.post('/api/migrations/:id/resume', { preHandler: guards.csrf }, async (request, reply) => {
    const migration = await ownedMigration(prisma, request.user.id, request.params.id);
    if (!migration) return notFound(reply);
    if (!['PAUSED', 'AUTHENTICATION_REQUIRED', 'QUOTA_PAUSED', 'FAILED'].includes(migration.status)) return reply.code(409).send({ error: { code: 'INVALID_MIGRATION_STATE', message: 'This migration cannot be resumed.' } });
    const status = migration.phase === 'SCANNING' ? 'SCANNING' : 'QUEUED';
    const updated = await updateOwnedMigration(prisma, migration, request.user.id, {
      status, lastErrorCode: null, lastErrorMessage: null,
      workerId: null, leaseVersion: { increment: 1 },
    });
    if (!updated) return transitionConflict(reply);
    return reply.code(202).send({ migration: migrationJson(updated) });
  });

  app.post('/api/migrations/:id/retry', { preHandler: guards.csrf }, async (request, reply) => {
    const migration = await ownedMigration(prisma, request.user.id, request.params.id);
    if (!migration) return notFound(reply);
    if (!['READY', 'COMPLETED', 'FAILED'].includes(migration.status)) {
      return reply.code(409).send({ error: { code: 'INVALID_MIGRATION_STATE', message: 'Failed tracks cannot be retried while a worker is active.' } });
    }
    let updated;
    try {
      updated = await serializableTransaction(prisma, async (tx) => {
        const locked = await tx.migration.updateMany({
          where: { id: migration.id, userId: request.user.id, status: migration.status, phase: migration.phase, leaseVersion: migration.leaseVersion },
          data: { workerId: null, lockedUntil: null, leaseVersion: { increment: 1 } },
        });
        if (!locked.count) throw routeError(409, 'MIGRATION_STATE_CHANGED', 'The migration changed before retry could begin.');
        const likeFailures = await tx.migrationTrack.updateMany({ where: { migrationId: migration.id, status: 'FAILED', matchedYoutubeVideoId: { not: null } }, data: { status: 'READY', errorCode: null, errorMessage: null } });
        const searchFailures = await tx.migrationTrack.updateMany({ where: { migrationId: migration.id, status: 'FAILED', matchedYoutubeVideoId: null }, data: { status: 'PENDING', errorCode: null, errorMessage: null } });
        if (!likeFailures.count && !searchFailures.count) throw routeError(409, 'NO_FAILED_TRACKS', 'There are no failed tracks to retry.');
        const phase = searchFailures.count ? 'SCANNING' : 'LIKING';
        const status = searchFailures.count ? 'SCANNING' : 'QUEUED';
        const counters = await countMigrationTracks(tx, migration.id, phase);
        return tx.migration.update({ where: { id: migration.id }, data: { ...counters, phase, status, lastErrorCode: null, lastErrorMessage: null, completedAt: null } });
      });
    } catch (error) {
      if (error.statusCode) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    }
    return reply.code(202).send({ migration: migrationJson(updated) });
  });

  app.get('/api/migrations/:id/tracks', { preHandler: guards.required }, async (request, reply) => {
    const migration = await ownedMigration(prisma, request.user.id, request.params.id);
    if (!migration) return notFound(reply);
    const parsed = listQuery.safeParse(request.query || {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_QUERY', message: 'Invalid pagination.' } });
    const { page, limit, status } = parsed.data;
    const where = { migrationId: migration.id, ...(status ? { status: status.toUpperCase() } : {}) };
    const [tracks, total] = await Promise.all([
      prisma.migrationTrack.findMany({ where, orderBy: { position: 'asc' }, skip: (page - 1) * limit, take: limit }),
      prisma.migrationTrack.count({ where }),
    ]);
    return { tracks: tracks.map(trackJson), page, limit, total };
  });

  app.get('/api/migrations/:id/reviews', { preHandler: guards.required }, async (request, reply) => {
    const migration = await ownedMigration(prisma, request.user.id, request.params.id);
    if (!migration) return notFound(reply);
    const parsed = listQuery.safeParse(request.query || {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_QUERY', message: 'Invalid pagination.' } });
    const { page, limit } = parsed.data;
    const where = { migrationId: migration.id, status: 'REVIEW' };
    const [tracks, total] = await Promise.all([
      prisma.migrationTrack.findMany({ where, include: { candidates: { orderBy: { position: 'asc' } } }, orderBy: { position: 'asc' }, skip: (page - 1) * limit, take: limit }),
      prisma.migrationTrack.count({ where }),
    ]);
    return { reviews: tracks.map((track) => trackJson(track, true)), page, limit, total };
  });

  app.post('/api/migrations/:id/reviews/:trackId/choose', { preHandler: guards.csrf }, async (request, reply) => {
    const schema = z.object({ candidateId: z.string().min(1) });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Choose a valid candidate.' } });
    const migration = await ownedMigration(prisma, request.user.id, request.params.id);
    if (!migration) return notFound(reply);
    try {
      await serializableTransaction(prisma, async (tx) => {
        const candidate = await tx.migrationCandidate.findFirst({ where: { id: parsed.data.candidateId, trackId: request.params.trackId } });
        if (!candidate) throw routeError(400, 'INVALID_CANDIDATE', 'That candidate does not belong to this track.');
        const changed = await tx.migrationTrack.updateMany({
          where: { id: request.params.trackId, migrationId: migration.id, status: 'REVIEW' },
          data: { status: 'READY', matchedYoutubeVideoId: candidate.videoId, matchedYoutubeTitle: candidate.title, matchedYoutubeArtists: candidate.artists, score: candidate.score, confidence: 'USER_SELECTED', reason: null },
        });
        if (!changed.count) throw routeError(409, 'REVIEW_ALREADY_RESOLVED', 'This review item was already resolved.');
        const currentMigration = await tx.migration.findUnique({ where: { id: migration.id } });
        const counters = await countMigrationTracks(tx, migration.id, currentMigration.phase);
        await tx.migration.update({ where: { id: migration.id }, data: {
          ...counters,
          ...(currentMigration.status === 'COMPLETED' ? { status: 'QUEUED', completedAt: null, leaseVersion: { increment: 1 } } : {}),
        } });
      });
    } catch (error) {
      if (error.statusCode) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    }
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/migrations/:id/reviews/:trackId/skip', { preHandler: guards.csrf }, async (request, reply) => {
    const migration = await ownedMigration(prisma, request.user.id, request.params.id);
    if (!migration) return notFound(reply);
    try {
      await serializableTransaction(prisma, async (tx) => {
        const changed = await tx.migrationTrack.updateMany({ where: { id: request.params.trackId, migrationId: migration.id, status: 'REVIEW' }, data: { status: 'SKIPPED' } });
        if (!changed.count) throw routeError(409, 'REVIEW_ALREADY_RESOLVED', 'This review item was already resolved.');
        const currentMigration = await tx.migration.findUnique({ where: { id: migration.id } });
        const counters = await countMigrationTracks(tx, migration.id, currentMigration.phase);
        await tx.migration.update({ where: { id: migration.id }, data: counters });
      });
    } catch (error) {
      if (error.statusCode) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    }
    return { ok: true };
  });

  app.post('/api/migrations/:id/reviews/:trackId/search', { preHandler: guards.csrf }, async (request, reply) => {
    const parsed = z.object({ query: z.string().trim().min(2).max(200) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_QUERY', message: 'Enter a search query.' } });
    const migration = await ownedMigration(prisma, request.user.id, request.params.id);
    if (!migration) return notFound(reply);
    const track = await prisma.migrationTrack.findFirst({ where: { id: request.params.trackId, migrationId: migration.id, status: 'REVIEW' } });
    if (!track) return reply.code(404).send({ error: { code: 'REVIEW_NOT_FOUND', message: 'Review item not found.' } });
    const candidates = await ytmusic.runPython(['search', '--query', parsed.data.query, '--limit', '10']).then((payload) => payload.results || []);
    const result = matchTrack({ title: track.spotifyTitle, artists: track.spotifyArtists, album: track.spotifyAlbum, durationMs: track.spotifyDurationMs }, candidates, { threshold: Number(process.env.MATCH_CONFIDENCE_THRESHOLD || 0.85) });
    await prisma.migrationCandidate.deleteMany({ where: { trackId: track.id } });
    await prisma.migrationCandidate.createMany({ data: result.candidates.map((candidate, position) => ({ trackId: track.id, position, videoId: candidate.videoId, title: candidate.title, artists: candidate.artists || [], album: candidate.album || null, durationMs: candidate.durationMs || null, resultType: candidate.resultType || null, videoType: candidate.videoType || null, score: candidate.score, reasons: candidate.reasons || [] })) });
    const updated = await prisma.migrationTrack.findUnique({ where: { id: track.id }, include: { candidates: { orderBy: { position: 'asc' } } } });
    return { review: trackJson(updated, true) };
  });

  app.get('/api/migrations/:id/events', { preHandler: guards.required }, async (request, reply) => {
    const migration = await ownedMigration(prisma, request.user.id, request.params.id);
    if (!migration) return notFound(reply);
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.raw.write('retry: 2000\n\n');
    let closed = false;
    let timer;
    let lastEventId = request.headers['last-event-id'] || '';
    let lastWriteAt = Date.now();
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
    };
    const fail = () => {
      cleanup();
      if (!reply.raw.destroyed) reply.raw.end();
    };
    const send = async () => {
      if (closed || reply.raw.destroyed) return cleanup();
      const current = await ownedMigration(prisma, request.user.id, migration.id);
      if (!current) {
        cleanup();
        reply.raw.end();
        return;
      }
      const serialized = migrationJson(current);
      if (shouldSendMigration(lastEventId, current)) {
        reply.raw.write(migrationEvent(serialized));
        lastEventId = migrationEventId(current);
        lastWriteAt = Date.now();
      } else if (Date.now() - lastWriteAt >= 15_000) {
        reply.raw.write(': keepalive\n\n');
        lastWriteAt = Date.now();
      }
      if (!closed) timer = setTimeout(() => send().catch(fail), 1500);
    };
    request.raw.once('close', cleanup);
    request.raw.once('error', cleanup);
    await send().catch(fail);
  });
}

module.exports = { registerMigrationRoutes, ownedMigration, updateOwnedMigration, serializableTransaction };
