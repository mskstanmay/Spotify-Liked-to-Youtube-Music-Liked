const { randomToken, hashToken, csrfToken, timingSafeEqual } = require('./security');

async function createSession(prisma, userId, config) {
  const token = randomToken(32);
  const session = await prisma.appSession.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + config.sessionDays * 86_400_000),
    },
  });
  return { token, session };
}

function setSessionCookie(reply, token, config) {
  reply.setCookie(config.sessionCookieName, token, {
    path: '/',
    httpOnly: true,
    signed: true,
    secure: config.secureDeployment ?? config.nodeEnv === 'production',
    sameSite: 'lax',
    maxAge: config.sessionDays * 86_400,
  });
}

function clearSessionCookie(reply, config) {
  reply.clearCookie(config.sessionCookieName, { path: '/' });
}

async function readSession(request, prisma, config) {
  const signed = request.cookies?.[config.sessionCookieName];
  if (!signed) return null;
  const unsigned = request.unsignCookie(signed);
  if (!unsigned.valid) return null;
  const session = await prisma.appSession.findFirst({
    where: { tokenHash: hashToken(unsigned.value), expiresAt: { gt: new Date() } },
    include: { user: true },
  });
  return session || null;
}

function sessionGuards(prisma, config) {
  async function optional(request) {
    if (request.session !== undefined) return request.session;
    request.session = await readSession(request, prisma, config);
    return request.session;
  }

  async function required(request, reply) {
    const session = await optional(request);
    if (!session) return reply.code(401).send({ error: { code: 'AUTHENTICATION_REQUIRED', message: 'Please sign in to continue.' } });
    request.user = session.user;
  }

  async function csrf(request, reply) {
    const blocked = await required(request, reply);
    if (blocked) return blocked;
    const expected = csrfToken(request.session.id, config.sessionSecret);
    if (!timingSafeEqual(request.headers['x-csrf-token'], expected)) {
      return reply.code(403).send({ error: { code: 'INVALID_CSRF_TOKEN', message: 'Your session could not be verified. Refresh and try again.' } });
    }
  }

  return { optional, required, csrf };
}

module.exports = { createSession, setSessionCookie, clearSessionCookie, readSession, sessionGuards };
