const { randomToken, hashToken, encryptSecret, decryptSecret, pkceChallenge, safeReturnTo, csrfToken } = require('./security');
const { createSession, setSessionCookie, clearSessionCookie } = require('./session');
const spotify = require('../providers/spotify/web');
const youtube = require('../providers/youtube/web');
const { connectionState } = require('../providers/connectionHealth');

const providerDefinitions = {
  spotify: { enum: 'SPOTIFY', connection: 'spotifyConnection', implementation: spotify },
  google: { enum: 'GOOGLE', connection: 'youTubeConnection', implementation: youtube },
};

function connectionJson(connection) {
  const state = connectionState(connection);
  if (!connection) return state;
  return {
    ...state,
    accountName: connection.accountName,
    providerAccountId: connection.providerAccountId,
    scopes: connection.scopes,
    expiresAt: connection.expiresAt,
  };
}

async function connectAccount(prisma, definition, stateRow, providerProfile, tokenData, config) {
  return prisma.$transaction(async (tx) => {
    const model = tx[definition.connection];
    const existingProvider = await model.findUnique({ where: { providerAccountId: providerProfile.id } });
    if (stateRow.userId && existingProvider && existingProvider.userId !== stateRow.userId) {
      const error = new Error('That provider account is already connected to another user.');
      error.statusCode = 409;
      error.code = 'ACCOUNT_ALREADY_CONNECTED';
      throw error;
    }

    const userId = stateRow.userId || existingProvider?.userId || (await tx.user.create({ data: {} })).id;
    const previous = await model.findUnique({ where: { userId } });
    const sameAccount = previous?.providerAccountId === providerProfile.id;
    const previousRefresh = sameAccount && previous.encryptedRefreshToken
      ? decryptSecret(previous.encryptedRefreshToken, config.tokenEncryptionKey)
      : null;

    if (!tokenData.refresh_token && !previousRefresh) {
      const error = new Error('The provider did not issue a refresh token for this account. Please connect it again.');
      error.statusCode = 409;
      error.code = 'REFRESH_TOKEN_REQUIRED';
      throw error;
    }

    const encrypted = {
      ...definition.implementation.tokenRecord(tokenData, config, previousRefresh),
      connectionStatus: 'ACTIVE',
      lastAuthErrorCode: null,
      authInvalidAt: null,
    };
    const refreshFence = definition.connection === 'youTubeConnection'
      ? { refreshVersion: { increment: 1 }, refreshOwner: null, refreshLockedUntil: null }
      : {};
    await model.upsert({
      where: { userId },
      create: { userId, providerAccountId: providerProfile.id, accountName: providerProfile.name, ...encrypted },
      update: { providerAccountId: providerProfile.id, accountName: providerProfile.name, ...encrypted, ...refreshFence },
    });
    return userId;
  }, { isolationLevel: 'Serializable' });
}

function registerAuthRoutes(app, { prisma, config, guards }) {
  app.get('/api/auth/:provider', async (request, reply) => {
    const definition = providerDefinitions[request.params.provider];
    if (!definition) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown provider.' } });
    const session = await guards.optional(request);
    const state = randomToken(32);
    const verifier = randomToken(48);
    await prisma.oAuthState.create({
      data: {
        userId: session?.userId || null,
        provider: definition.enum,
        stateHash: hashToken(state),
        encryptedCodeVerifier: encryptSecret(verifier, config.tokenEncryptionKey),
        returnTo: safeReturnTo(request.query?.returnTo),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    return reply.redirect(definition.implementation.authorizationUrl(config, state, pkceChallenge(verifier)));
  });

  app.get('/api/auth/:provider/callback', async (request, reply) => {
    const definition = providerDefinitions[request.params.provider];
    if (!definition) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown provider.' } });
    const stateHash = hashToken(request.query?.state || '');
    const stateRow = await prisma.oAuthState.findUnique({ where: { stateHash } });
    if (!stateRow || stateRow.provider !== definition.enum || stateRow.expiresAt <= new Date()) {
      return reply.code(400).send({ error: { code: 'INVALID_OAUTH_STATE', message: 'This sign-in request expired or could not be verified.' } });
    }
    await prisma.oAuthState.delete({ where: { id: stateRow.id } });
    if (request.query?.error || !request.query?.code) {
      return reply.redirect(`${config.webBaseUrl}${stateRow.returnTo}?auth_error=access_denied`);
    }
    const verifier = decryptSecret(stateRow.encryptedCodeVerifier, config.tokenEncryptionKey);
    const token = await definition.implementation.exchangeCode(config, request.query.code, verifier);
    const providerProfile = await definition.implementation.profile(token.access_token, config);
    const userId = await connectAccount(prisma, definition, stateRow, providerProfile, token, config);
    const { token: sessionToken } = await createSession(prisma, userId, config);
    setSessionCookie(reply, sessionToken, config);
    return reply.redirect(`${config.webBaseUrl}${stateRow.returnTo}?connected=${request.params.provider}`);
  });

  app.get('/api/me', { preHandler: guards.required }, async (request) => ({
    user: { id: request.user.id, createdAt: request.user.createdAt },
    csrfToken: csrfToken(request.session.id, config.sessionSecret),
  }));

  app.get('/api/connections', { preHandler: guards.required }, async (request) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      include: { spotifyConnection: true, youtubeConnection: true },
    });
    return {
      spotify: connectionJson(user.spotifyConnection),
      youtube: connectionJson(user.youtubeConnection),
      migrationLimits: { maximum: config.migrationMaxTracks },
    };
  });

  app.post('/api/logout', { preHandler: guards.csrf }, async (request, reply) => {
    await prisma.appSession.delete({ where: { id: request.session.id } }).catch(() => {});
    clearSessionCookie(reply, config);
    return { ok: true };
  });

  app.delete('/api/connections/:provider', { preHandler: guards.csrf }, async (request, reply) => {
    const model = request.params.provider === 'spotify'
      ? prisma.spotifyConnection
      : request.params.provider === 'youtube' ? prisma.youTubeConnection : null;
    if (!model) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown provider.' } });
    const connection = await model.findUnique({ where: { userId: request.user.id } });
    if (request.params.provider === 'youtube') await youtube.revokeConnection(connection, config);
    await model.deleteMany({ where: { userId: request.user.id } });
    return { ok: true };
  });

  app.delete('/api/account', { preHandler: guards.csrf }, async (request, reply) => {
    const youtubeConnection = await prisma.youTubeConnection.findUnique({ where: { userId: request.user.id } });
    await youtube.revokeConnection(youtubeConnection, config);
    await prisma.user.delete({ where: { id: request.user.id } });
    clearSessionCookie(reply, config);
    return reply.code(204).send();
  });
}

module.exports = { registerAuthRoutes, connectionJson, connectAccount };
