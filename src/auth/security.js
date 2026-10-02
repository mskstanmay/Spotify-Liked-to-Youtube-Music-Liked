const crypto = require('node:crypto');

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function randomToken(bytes = 32) {
  return base64url(crypto.randomBytes(bytes));
}

function hashToken(value) {
  return crypto.createHash('sha256').update(String(value)).digest('base64url');
}

function encryptionKey(raw) {
  const encoded = String(raw || '');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key. Generate one with: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64\'))"');
  }
  let key;
  try {
    key = Buffer.from(encoded, 'base64');
  } catch {
    key = Buffer.alloc(0);
  }
  if (key.length !== 32 || key.toString('base64') !== encoded) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key. Generate one with: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64\'))"');
  }
  return key;
}

function validateEncryptionKey(raw) {
  encryptionKey(raw);
  return true;
}

function encryptSecret(value, rawKey) {
  if (value === null || value === undefined || value === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(rawKey), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${base64url(iv)}.${base64url(tag)}.${base64url(ciphertext)}`;
}

function decryptSecret(payload, rawKey) {
  if (!payload) return null;
  const [version, iv, tag, ciphertext] = String(payload).split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Invalid encrypted secret.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(rawKey), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

function pkceChallenge(verifier) {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

function csrfToken(sessionId, secret) {
  return crypto.createHmac('sha256', secret).update(sessionId).digest('base64url');
}

function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function safeReturnTo(value) {
  const candidate = String(value || '/connections');
  return candidate.startsWith('/') && !candidate.startsWith('//') ? candidate : '/connections';
}

module.exports = {
  randomToken,
  hashToken,
  encryptSecret,
  decryptSecret,
  pkceChallenge,
  csrfToken,
  timingSafeEqual,
  safeReturnTo,
  validateEncryptionKey,
};
