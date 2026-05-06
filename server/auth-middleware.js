'use strict';

function extractBearerToken(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const [scheme, token] = headerValue.trim().split(/\s+/, 2);
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') return null;
  return token.trim() || null;
}

function resolveAuthSession({ token, verifyAuthToken, secret, db }) {
  const session = verifyAuthToken(token, secret);
  if (!session) {
    return {
      ok: false,
      code: 'invalid_session',
      message: 'Oturumun geçersiz. Tekrar giriş yap.',
    };
  }
  if (db.isTokenRevoked(session.tokenId)) {
    return {
      ok: false,
      code: 'revoked_session',
      message: 'Oturumun kapatılmış. Tekrar giriş yap.',
    };
  }
  if (!db.getAccount(session.username)) {
    return {
      ok: false,
      code: 'missing_account',
      message: 'Hesap bulunamadı. Tekrar giriş yap.',
    };
  }
  return { ok: true, session };
}

function createHttpAuthMiddleware({ verifyAuthToken, secret, db }) {
  function requireAuth(req, res, next) {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      res.status(401).json({ error: 'Giriş yapman gerekiyor.', code: 'missing_token' });
      return;
    }

    const resolved = resolveAuthSession({ token, verifyAuthToken, secret, db });
    if (!resolved.ok) {
      res.status(401).json({ error: resolved.message, code: resolved.code });
      return;
    }

    req.auth = {
      ...resolved.session,
      token,
    };
    next();
  }

  return {
    requireAuth,
  };
}

function createSocketAuthMiddleware({ verifyAuthToken, secret, db }) {
  return (socket, next) => {
    const token = socket.handshake.auth?.token;
    const resolved = resolveAuthSession({ token, verifyAuthToken, secret, db });
    if (!resolved.ok) {
      const err = new Error(resolved.message);
      err.data = { code: resolved.code };
      next(err);
      return;
    }

    socket.data.auth = {
      ...resolved.session,
      token,
    };
    next();
  };
}

module.exports = {
  createHttpAuthMiddleware,
  createSocketAuthMiddleware,
  extractBearerToken,
  resolveAuthSession,
};
