const crypto = require('node:crypto');
const { fetchLikedTracks } = require('../providers/spotify/web');
const youtube = require('../providers/youtube/web');
const ytmusic = require('../ytmusic/client');
const { matchTrack } = require('../matching/trackMatcher');
const { withRetries, sleep } = require('../utils/retry');
const { countMigrationTracks, refreshCounts } = require('../migration/state');
const { tryClaimVideoLike, recordVideoLiked, completeVideoLike, releaseVideoLike } = require('./videoLikeCoordinator');
const { logOperation } = require('../utils/operationLogger');

const CLAIMABLE_STATUSES = ['SCANNING', 'QUEUED', 'RUNNING'];

class LeaseLostError extends Error {
  constructor() {
    super('The migration lease is no longer owned by this worker.');
    this.name = 'LeaseLostError';
    this.code = 'WORKER_LEASE_LOST';
  }
}

function candidateRows(trackId, candidates) {
  return candidates.slice(0, 10).map((candidate, position) => ({
    trackId,
    position,
    videoId: candidate.videoId,
    title: candidate.title || 'Untitled',
    artists: candidate.artists || [],
    album: candidate.album || null,
    durationMs: candidate.durationMs || null,
    resultType: candidate.resultType || null,
    videoType: candidate.videoType || null,
    score: candidate.score ?? 0,
    reasons: candidate.reasons || [],
  }));
}

function publicWorkerError(error) {
  if (error.authenticationRequired) return { status: 'AUTHENTICATION_REQUIRED', code: 'AUTHENTICATION_REQUIRED', message: `${error.provider || 'A provider'} needs to be connected again.` };
  if (error.quotaExceeded) return { status: 'QUOTA_PAUSED', code: 'YOUTUBE_QUOTA_EXCEEDED', message: 'YouTube API quota was reached. Your progress is safe; resume after quota becomes available.' };
  return { status: 'FAILED', code: error.code || 'MIGRATION_FAILED', message: error.retryable ? 'A provider is temporarily unavailable. Your progress is safe.' : 'The migration could not continue. Your progress is safe.' };
}

class MigrationWorker {
  constructor({ prisma, config, id = `worker-${process.pid}-${crypto.randomBytes(4).toString('hex')}`, logger = console, providers = {} }) {
    this.prisma = prisma;
    this.config = config;
    this.id = id;
    this.logger = logger;
    this.fetchLikedTracks = providers.fetchLikedTracks || fetchLikedTracks;
    this.youtube = providers.youtube || youtube;
    this.searchTrack = providers.searchTrack || ytmusic.searchTrack;
    this.stopped = true;
  }

  leaseDeadline() {
    return new Date(Date.now() + this.config.workerLeaseMs);
  }

  operation(level, job, fields) {
    logOperation(this.logger, level, {
      migrationId: job?.id,
      phase: job?.phase,
      workerId: this.id,
      ...fields,
    });
  }

  async reportRuntime() {
    if (!this.prisma.workerRuntime) return;
    await this.prisma.workerRuntime.upsert({
      where: { id: this.id },
      create: { id: this.id },
      update: { updatedAt: new Date() },
    });
  }

  fenceWhere(job, statuses = CLAIMABLE_STATUSES, requireUnexpired = true) {
    return {
      id: job.id,
      workerId: this.id,
      leaseVersion: job.leaseVersion,
      status: { in: statuses },
      ...(requireUnexpired ? { lockedUntil: { gt: new Date() } } : {}),
    };
  }

  async claim() {
    const now = new Date();
    const candidate = await this.prisma.migration.findFirst({
      where: {
        OR: [
          { status: 'SCANNING', phase: 'SCANNING' },
          { status: { in: ['QUEUED', 'RUNNING'] }, phase: 'LIKING' },
        ],
        AND: [{ OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] }],
      },
      orderBy: { updatedAt: 'asc' },
    });
    if (!candidate) return null;

    const claimed = await this.prisma.migration.updateMany({
      where: {
        id: candidate.id,
        status: candidate.status,
        phase: candidate.phase,
        leaseVersion: candidate.leaseVersion,
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
      data: {
        workerId: this.id,
        lockedUntil: this.leaseDeadline(),
        leaseVersion: { increment: 1 },
      },
    });
    if (!claimed.count) return null;
    const job = await this.prisma.migration.findFirst({
      where: { id: candidate.id, workerId: this.id, leaseVersion: candidate.leaseVersion + 1 },
    });
    if (job) this.operation('info', job, { operation: 'claim', provider: 'database', result: 'claimed' });
    return job;
  }

  async heartbeat(job) {
    if (job.leaseLost) throw new LeaseLostError();
    const lockedUntil = this.leaseDeadline();
    let renewed;
    try {
      renewed = await this.prisma.migration.updateMany({
        where: this.fenceWhere(job),
        data: { lockedUntil },
      });
    } catch (error) {
      job.leaseLost = true;
      throw error;
    }
    if (!renewed.count) {
      job.leaseLost = true;
      throw new LeaseLostError();
    }
    try {
      if (job.videoClaim) {
        const videoRenewed = await this.prisma.youTubeVideoLike.updateMany({
          where: {
            id: job.videoClaim.id,
            status: 'PENDING',
            ownerId: job.videoClaim.ownerId,
            leaseVersion: job.videoClaim.leaseVersion,
            lockedUntil: { gt: new Date() },
          },
          data: { lockedUntil },
        });
        if (!videoRenewed.count) {
          job.leaseLost = true;
          throw new LeaseLostError();
        }
      }
      await this.reportRuntime();
    } catch (error) {
      if (!(error instanceof LeaseLostError)) {
        job.leaseLost = true;
      }
      throw error;
    }
    job.lockedUntil = lockedUntil;
    return true;
  }

  startHeartbeat(job) {
    const intervalMs = Math.max(10, Math.floor(this.config.workerLeaseMs / 3));
    let inFlight = Promise.resolve();
    const tick = () => {
      inFlight = inFlight.then(() => this.heartbeat(job)).catch((error) => {
        // A worker that cannot prove lease renewal must stop issuing new
        // provider operations, even when the database error was transient.
        job.leaseLost = true;
        if (!(error instanceof LeaseLostError)) this.operation('error', job, { operation: 'heartbeat', provider: 'database', result: 'failed', reason: error.code || 'DATABASE_ERROR' });
      });
    };
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    return async () => {
      clearInterval(timer);
      await inFlight;
    };
  }

  async release(job) {
    await releaseVideoLike(this.prisma, job.videoClaim).catch(() => {});
    job.videoClaim = null;
    await this.prisma.migration.updateMany({
      where: { id: job.id, workerId: this.id, leaseVersion: job.leaseVersion },
      data: { workerId: null, lockedUntil: null },
    });
  }

  async owns(job, statuses) {
    if (job.leaseLost) return false;
    const row = await this.prisma.migration.findFirst({
      where: this.fenceWhere(job, statuses),
      select: { id: true },
    });
    if (!row) job.leaseLost = true;
    return Boolean(row);
  }

  async fencedTransaction(job, statuses, callback) {
    if (job.leaseLost) throw new LeaseLostError();
    return this.prisma.$transaction(async (tx) => {
      const lockedUntil = this.leaseDeadline();
      const fenced = await tx.migration.updateMany({
        where: this.fenceWhere(job, statuses),
        data: { lockedUntil },
      });
      if (!fenced.count) throw new LeaseLostError();
      job.lockedUntil = lockedUntil;
      return callback(tx);
    });
  }

  async updateMigration(job, statuses, data) {
    return this.fencedTransaction(job, statuses, (tx) => tx.migration.update({ where: { id: job.id }, data }));
  }

  async acquireVideoLike(job, userId, videoId) {
    const ownerId = `${this.id}:${job.leaseVersion}`;
    while (await this.owns(job, ['RUNNING'])) {
      const result = await tryClaimVideoLike(this.prisma, { userId, videoId, ownerId, lockedUntil: this.leaseDeadline() });
      if (result.state === 'LIKED') return result;
      if (result.state === 'CLAIMED') {
        job.videoClaim = result.claim;
        return result;
      }
      await sleep(100);
    }
    throw new LeaseLostError();
  }

  async finishVideoTrack(job, track, status) {
    const claim = job.videoClaim;
    job.videoClaim = null;
    try {
      await this.fencedTransaction(job, ['RUNNING'], async (tx) => {
        const completed = await completeVideoLike(tx, claim);
        if (!completed.count) {
          const current = await tx.youTubeVideoLike.findUnique({ where: { id: claim.id }, select: { status: true } });
          if (current?.status !== 'LIKED') throw new LeaseLostError();
        }
        await tx.migrationTrack.updateMany({
          where: { id: track.id, migrationId: job.id, status: { in: ['READY', 'LIKING'] } },
          data: { status, errorCode: null, errorMessage: null },
        });
      });
    } catch (error) {
      job.videoClaim = claim;
      throw error;
    }
  }

  async scan(job) {
    const user = await this.prisma.user.findUnique({ where: { id: job.userId }, include: { spotifyConnection: true } });
    let trackCount = await this.prisma.migrationTrack.count({ where: { migrationId: job.id } });
    if (!trackCount) {
      const fetchStartedAt = Date.now();
      const { tracks, sourceTotal } = await this.fetchLikedTracks(
        this.prisma,
        user?.spotifyConnection,
        this.config,
        async (count, total) => {
          await this.updateMigration(job, ['SCANNING'], {
            totalTracks: total || count,
            processedTracks: 0,
            currentTrackTitle: 'Fetching your Spotify library',
            currentTrackArtist: `${count} of ${total || '?'}`,
          });
        },
        () => { if (job.leaseLost) throw new LeaseLostError(); },
        job.trackLimit,
        (error, retryNumber) => this.operation('warn', job, {
          operation: 'fetch_liked_tracks', provider: 'spotify', retryNumber,
          result: 'retry', reason: error.code || 'TRANSIENT_ERROR',
        }),
      );
      this.operation('info', job, {
        operation: 'fetch_liked_tracks', provider: 'spotify', durationMs: Date.now() - fetchStartedAt,
        result: 'success', trackCount: tracks.length,
      });
      await this.fencedTransaction(job, ['SCANNING'], async (tx) => {
        if (tracks.length) {
          await tx.migrationTrack.createMany({
            data: tracks.map((track, position) => ({
              migrationId: job.id,
              position: position + 1,
              spotifyTrackId: track.spotifyTrackId,
              spotifyTitle: track.title,
              spotifyArtists: track.artists,
              spotifyAlbum: track.album,
              spotifyDurationMs: track.durationMs,
              spotifyUrl: track.spotifyUrl,
            })),
            skipDuplicates: true,
          });
        }
        trackCount = await tx.migrationTrack.count({ where: { migrationId: job.id } });
        await tx.migration.update({ where: { id: job.id }, data: { totalTracks: trackCount, sourceTotalTracks: sourceTotal } });
      });
    }

    while (await this.owns(job, ['SCANNING'])) {
      const track = await this.prisma.migrationTrack.findFirst({
        where: { migrationId: job.id, status: { in: ['PENDING', 'SCANNING'] } },
        orderBy: { position: 'asc' },
      });
      if (!track) break;
      const began = await this.fencedTransaction(job, ['SCANNING'], async (tx) => {
        const changed = await tx.migrationTrack.updateMany({
          where: { id: track.id, migrationId: job.id, status: { in: ['PENDING', 'SCANNING'] } },
          data: { status: 'SCANNING', errorCode: null, errorMessage: null },
        });
        if (!changed.count) return false;
        await tx.migration.update({ where: { id: job.id }, data: { currentTrackTitle: track.spotifyTitle, currentTrackArtist: track.spotifyArtists.join(', ') } });
        return true;
      });
      if (!began) continue;

      try {
        const searchStartedAt = Date.now();
        const candidates = await withRetries(() => {
          if (job.leaseLost) throw new LeaseLostError();
          return this.searchTrack({ title: track.spotifyTitle, artists: track.spotifyArtists });
        }, {
          retries: this.config.maxRetries,
          baseDelayMs: 700,
          shouldRetry: () => !job.leaseLost,
          onRetry: (error, retryNumber) => this.operation('warn', job, {
            trackId: track.id, operation: 'search', provider: 'youtube_music', retryNumber,
            result: 'retry', reason: error.code || 'TRANSIENT_ERROR',
          }),
        });
        const result = matchTrack(
          { title: track.spotifyTitle, artists: track.spotifyArtists, album: track.spotifyAlbum, durationMs: track.spotifyDurationMs },
          candidates,
          { threshold: Number(process.env.MATCH_CONFIDENCE_THRESHOLD || 0.85) },
        );
        await this.fencedTransaction(job, ['SCANNING'], async (tx) => {
          await tx.migrationCandidate.deleteMany({ where: { trackId: track.id } });
          if (result.candidates.length) await tx.migrationCandidate.createMany({ data: candidateRows(track.id, result.candidates) });
          await tx.migrationTrack.updateMany({
            where: { id: track.id, migrationId: job.id, status: 'SCANNING' },
            data: result.candidates.length === 0
              ? { status: 'NOT_FOUND', reason: result.reason }
              : result.matched
                ? { status: 'READY', matchedYoutubeVideoId: result.videoId, matchedYoutubeTitle: result.title, matchedYoutubeArtists: result.artists, confidence: result.confidence, score: result.score, reason: null }
                : { status: 'REVIEW', confidence: result.confidence, score: result.score, reason: result.reason },
          });
          const counters = await countMigrationTracks(tx, job.id, 'SCANNING');
          await tx.migration.update({ where: { id: job.id }, data: counters });
        });
        this.operation('info', job, {
          trackId: track.id, operation: 'search', provider: 'youtube_music',
          durationMs: Date.now() - searchStartedAt,
          result: result.candidates.length === 0 ? 'not_found' : result.matched ? 'ready' : 'review',
        });
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        this.operation('error', job, {
          trackId: track.id, operation: 'search', provider: 'youtube_music',
          result: 'failed', reason: error.code || 'SEARCH_FAILED',
        });
        await this.fencedTransaction(job, ['SCANNING'], async (tx) => {
          await tx.migrationTrack.updateMany({
            where: { id: track.id, migrationId: job.id, status: 'SCANNING' },
            data: { status: 'FAILED', errorCode: 'SEARCH_FAILED', errorMessage: 'We could not search YouTube Music for this track.' },
          });
          const counters = await countMigrationTracks(tx, job.id, 'SCANNING');
          await tx.migration.update({ where: { id: job.id }, data: counters });
        });
      }
      if (this.config.requestDelayMs) await sleep(this.config.requestDelayMs);
    }

    await this.fencedTransaction(job, ['SCANNING'], async (tx) => {
      const remaining = await tx.migrationTrack.count({ where: { migrationId: job.id, status: { in: ['PENDING', 'SCANNING'] } } });
      if (remaining) return;
      const counters = await countMigrationTracks(tx, job.id, 'SCANNING');
      await tx.migration.update({
        where: { id: job.id },
        data: {
          ...counters,
          status: job.startedAt ? 'QUEUED' : 'READY',
          phase: 'LIKING',
          currentTrackTitle: null,
          currentTrackArtist: null,
        },
      });
    });
  }

  async migrate(job) {
    await this.fencedTransaction(job, ['QUEUED', 'RUNNING'], async (tx) => {
      const counters = await countMigrationTracks(tx, job.id, 'LIKING');
      await tx.migration.update({ where: { id: job.id }, data: { ...counters, status: 'RUNNING', phase: 'LIKING', startedAt: job.startedAt || new Date() } });
    });

    const user = await this.prisma.user.findUnique({ where: { id: job.userId }, include: { youtubeConnection: true } });
    const pending = await this.prisma.migrationTrack.findMany({ where: { migrationId: job.id, status: { in: ['READY', 'LIKING'] } }, orderBy: { position: 'asc' } });
    const ratingsStartedAt = Date.now();
    const ratingMap = await this.youtube.ratings(
      this.prisma,
      user?.youtubeConnection,
      this.config,
      pending.map((track) => track.matchedYoutubeVideoId).filter(Boolean),
      (retryNumber = 0) => {
        if (job.leaseLost) throw new LeaseLostError();
        if (retryNumber > 0) this.operation('warn', job, { operation: 'get_ratings', provider: 'youtube', retryNumber, result: 'retry' });
      },
    );
    this.operation('info', job, {
      operation: 'get_ratings', provider: 'youtube', durationMs: Date.now() - ratingsStartedAt,
      result: 'success', trackCount: pending.length,
    });
    await this.heartbeat(job);

    for (const track of pending) {
      if (!(await this.owns(job, ['RUNNING']))) throw new LeaseLostError();
      await this.updateMigration(job, ['RUNNING'], { currentTrackTitle: track.spotifyTitle, currentTrackArtist: track.spotifyArtists.join(', ') });
      try {
        if (ratingMap.get(track.matchedYoutubeVideoId) === 'like') {
          await this.fencedTransaction(job, ['RUNNING'], async (tx) => {
            await recordVideoLiked(tx, job.userId, track.matchedYoutubeVideoId);
            await tx.migrationTrack.updateMany({ where: { id: track.id, migrationId: job.id, status: { in: ['READY', 'LIKING'] } }, data: { status: 'ALREADY_LIKED', errorCode: null, errorMessage: null } });
          });
          this.operation('info', job, { trackId: track.id, videoId: track.matchedYoutubeVideoId, operation: 'videos.rate', provider: 'youtube', result: 'already_liked' });
        } else {
          const currentConnection = await this.prisma.youTubeConnection.findUnique({ where: { userId: job.userId } });
          const began = await this.fencedTransaction(job, ['RUNNING'], async (tx) => {
            const changed = await tx.migrationTrack.updateMany({ where: { id: track.id, migrationId: job.id, status: { in: ['READY', 'LIKING'] } }, data: { status: 'LIKING' } });
            return changed.count > 0;
          });
          if (!began) continue;
          const coordinated = await this.acquireVideoLike(job, job.userId, track.matchedYoutubeVideoId);
          if (coordinated.state === 'LIKED') {
            await this.fencedTransaction(job, ['RUNNING'], (tx) => tx.migrationTrack.updateMany({
              where: { id: track.id, migrationId: job.id, status: 'LIKING' },
              data: { status: 'ALREADY_LIKED', errorCode: null, errorMessage: null },
            }));
            this.operation('info', job, { trackId: track.id, videoId: track.matchedYoutubeVideoId, operation: 'videos.rate', provider: 'youtube', result: 'duplicate_suppressed' });
          } else {
            const verifyStartedAt = Date.now();
            const currentRating = await this.youtube.ratings(
              this.prisma,
              currentConnection,
              this.config,
              [track.matchedYoutubeVideoId],
              async (retryNumber = 0) => {
                await this.heartbeat(job);
                if (retryNumber > 0) this.operation('warn', job, { trackId: track.id, operation: 'get_rating', provider: 'youtube', retryNumber, result: 'retry' });
              },
            );
            this.operation('info', job, { trackId: track.id, operation: 'get_rating', provider: 'youtube', durationMs: Date.now() - verifyStartedAt, result: 'success' });
            if (currentRating.get(track.matchedYoutubeVideoId) === 'like') {
              await this.finishVideoTrack(job, track, 'ALREADY_LIKED');
              this.operation('info', job, { trackId: track.id, videoId: track.matchedYoutubeVideoId, operation: 'videos.rate', provider: 'youtube', result: 'recovered_already_liked' });
            } else {
              const likeStartedAt = Date.now();
              await this.youtube.likeVideo(this.prisma, currentConnection, this.config, track.matchedYoutubeVideoId, async (retryNumber = 0) => {
                await this.heartbeat(job);
                if (retryNumber > 0) this.operation('warn', job, { trackId: track.id, operation: 'videos.rate', provider: 'youtube', retryNumber, result: 'retry' });
              });
              await this.finishVideoTrack(job, track, 'LIKED');
              this.operation('info', job, { trackId: track.id, videoId: track.matchedYoutubeVideoId, operation: 'videos.rate', provider: 'youtube', durationMs: Date.now() - likeStartedAt, result: 'liked' });
            }
          }
          ratingMap.set(track.matchedYoutubeVideoId, 'like');
        }
      } catch (error) {
        if (error instanceof LeaseLostError || error.authenticationRequired || error.quotaExceeded) throw error;
        const failedClaim = job.videoClaim;
        job.videoClaim = null;
        await this.fencedTransaction(job, ['RUNNING'], async (tx) => {
          await releaseVideoLike(tx, failedClaim, error.code || 'LIKE_FAILED');
          await tx.migrationTrack.updateMany({ where: { id: track.id, migrationId: job.id, status: { in: ['READY', 'LIKING'] } }, data: { status: 'FAILED', retryCount: { increment: 1 }, errorCode: error.code || 'LIKE_FAILED', errorMessage: 'Could not migrate this track.' } });
        });
        this.operation('error', job, { trackId: track.id, operation: 'videos.rate', provider: 'youtube', result: 'failed', reason: error.code || 'LIKE_FAILED' });
      }
      await this.fencedTransaction(job, ['RUNNING'], async (tx) => {
        const counters = await countMigrationTracks(tx, job.id, 'LIKING');
        await tx.migration.update({ where: { id: job.id }, data: counters });
      });
      if (this.config.requestDelayMs) await sleep(this.config.requestDelayMs);
    }

    const completed = await this.completeIfFinished(job);
    if (completed) this.operation('info', job, { operation: 'migration', provider: 'worker', result: 'completed' });
  }

  async completeIfFinished(job) {
    return this.fencedTransaction(job, ['RUNNING'], async (tx) => {
      const counters = await countMigrationTracks(tx, job.id, 'LIKING');
      const remaining = await tx.migrationTrack.count({ where: { migrationId: job.id, status: { in: ['PENDING', 'SCANNING', 'READY', 'LIKING'] } } });
      await tx.migration.update({ where: { id: job.id }, data: { ...counters, ...(remaining === 0 ? { status: 'COMPLETED', completedAt: new Date(), currentTrackTitle: null, currentTrackArtist: null } : {}) } });
      return remaining === 0;
    });
  }

  async runOnce() {
    const job = await this.claim();
    if (!job) return false;
    const stopHeartbeat = this.startHeartbeat(job);
    try {
      if (job.phase === 'SCANNING') await this.scan(job);
      else await this.migrate(job);
    } catch (error) {
      if (!(error instanceof LeaseLostError)) {
        const safe = publicWorkerError(error);
        await this.fencedTransaction(job, CLAIMABLE_STATUSES, (tx) => tx.migration.update({ where: { id: job.id }, data: { status: safe.status, lastErrorCode: safe.code, lastErrorMessage: safe.message } })).catch((nextError) => {
          if (!(nextError instanceof LeaseLostError)) throw nextError;
        });
        this.operation('error', job, { operation: 'migration', provider: error.provider || 'worker', result: safe.status.toLowerCase(), reason: safe.code });
      }
    } finally {
      await stopHeartbeat();
      await this.release(job).catch(() => {});
    }
    return true;
  }

  async start() {
    this.stopped = false;
    await this.reportRuntime();
    while (!this.stopped) {
      await this.reportRuntime();
      const worked = await this.runOnce().catch((error) => {
        logOperation(this.logger, 'error', { workerId: this.id, operation: 'worker_loop', provider: 'worker', result: 'failed', reason: error.code || 'WORKER_ERROR' });
        return false;
      });
      if (!worked) await sleep(this.config.workerPollMs);
    }
  }

  stop() {
    this.stopped = true;
  }
}

module.exports = { MigrationWorker, LeaseLostError, refreshCounts, publicWorkerError, candidateRows };
