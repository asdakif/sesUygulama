'use strict';

function extractBearerToken(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const [scheme, token] = headerValue.trim().split(/\s+/, 2);
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') return null;
  return token.trim() || null;
}

function resolveAuthSession({
  token,
  verifyAuthToken,
  secret,
  db,
  legacyTokenGraceUntil = null,
  now = Date.now(),
}) {
  const session = verifyAuthToken(token, secret);
  if (!session) {
    return {
      ok: false,
      code: 'invalid_session',
      message: 'Oturumun geçersiz. Tekrar giriş yap.',
    };
  }
  if (session.isLegacy && Number.isFinite(legacyTokenGraceUntil) && now > legacyTokenGraceUntil) {
    return {
      ok: false,
      code: 'legacy_token',
      message: 'Oturumun eski surumde kalmis. Tekrar giris yap.',
      username: session.username,
    };
  }
  if (db.isTokenRevoked(session.tokenId)) {
    return {
      ok: false,
      code: 'revoked_session',
      message: 'Oturumun kapatılmış. Tekrar giriş yap.',
    };
  }
  const account = db.getAccount(session.username);
  if (!account) {
    return {
      ok: false,
      code: 'missing_account',
      message: 'Hesap bulunamadı. Tekrar giriş yap.',
    };
  }
  if (account.disabled_at) {
    return {
      ok: false,
      code: 'account_disabled',
      message: 'Bu hesap devre dışı bırakılmış.',
    };
  }
  if (account.locked_until && account.locked_until > Date.now()) {
    return {
      ok: false,
      code: 'account_locked',
      message: 'Hesap geçici olarak kilitli. Biraz sonra tekrar dene.',
    };
  }
  if (Number.isFinite(account.token_version) && account.token_version !== session.tokenVersion) {
    return {
      ok: false,
      code: 'stale_token',
      message: 'Oturumun güncelliğini kaybetti. Tekrar giriş yap.',
    };
  }
  return {
    ok: true,
    session: {
      ...session,
      role: account.role || session.role || 'user',
      displayName: account.display_name || account.username,
    },
    migrateHint: session.isLegacy ? 'refresh' : null,
  };
}

function recordLegacyTokenEvent(audit, event, {
  username,
  ip,
  userAgent,
  transport,
}) {
  if (!audit || !username) return;
  audit.record(event, {
    actorUsername: username,
    ip,
    userAgent,
    metadata: { transport },
  });
}

function createHttpAuthMiddleware({
  verifyAuthToken,
  secret,
  db,
  audit = null,
  legacyTokenGraceUntil = null,
}) {
  function requireAuth(req, res, next) {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      res.status(401).json({ error: 'Giriş yapman gerekiyor.', code: 'missing_token' });
      return;
    }

    const resolved = resolveAuthSession({
      token,
      verifyAuthToken,
      secret,
      db,
      legacyTokenGraceUntil,
    });
    if (!resolved.ok) {
      if (resolved.code === 'legacy_token') {
        recordLegacyTokenEvent(audit, 'legacy_token_rejected', {
          username: resolved.username,
          ip: req.ip,
          userAgent: req.get('user-agent'),
          transport: 'http',
        });
      }
      res.status(401).json({ error: resolved.message, code: resolved.code });
      return;
    }
    if (resolved.migrateHint) {
      res.set('X-Auth-Migrate', resolved.migrateHint);
      recordLegacyTokenEvent(audit, 'legacy_token_used', {
        username: resolved.session.username,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        transport: 'http',
      });
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

function createSocketAuthMiddleware({
  verifyAuthToken,
  secret,
  db,
  audit = null,
  legacyTokenGraceUntil = null,
}) {
  return (socket, next) => {
    const token = socket.handshake.auth?.token;
    const resolved = resolveAuthSession({
      token,
      verifyAuthToken,
      secret,
      db,
      legacyTokenGraceUntil,
    });
    if (!resolved.ok) {
      if (resolved.code === 'legacy_token') {
        recordLegacyTokenEvent(audit, 'legacy_token_rejected', {
          username: resolved.username,
          ip: socket.handshake.address || null,
          userAgent: socket.handshake.headers?.['user-agent'] || null,
          transport: 'socket',
        });
      }
      const err = new Error(resolved.message);
      err.data = { code: resolved.code };
      next(err);
      return;
    }
    if (resolved.migrateHint) {
      recordLegacyTokenEvent(audit, 'legacy_token_used', {
        username: resolved.session.username,
        ip: socket.handshake.address || null,
        userAgent: socket.handshake.headers?.['user-agent'] || null,
        transport: 'socket',
      });
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
