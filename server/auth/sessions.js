'use strict';

const crypto = require('crypto');
const { createAuthToken } = require('./tokens');

function hashOpaqueTokenSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function buildRefreshTokenWire(tokenId, secret) {
  return `${tokenId}.${secret}`;
}

function parseRefreshToken(refreshToken) {
  if (typeof refreshToken !== 'string') return null;
  const trimmed = refreshToken.trim();
  const [tokenId, secret] = trimmed.split('.', 2);
  if (!tokenId || !secret) return null;
  return { tokenId, secret };
}

function createSessionManager({ db, config, audit, forceDisconnectUser = () => {} }) {
  const accessTokenRefreshMap = new Map();

  function pruneAccessTokenLinks(now = Date.now()) {
    for (const [accessTokenId, entry] of accessTokenRefreshMap) {
      if ((entry?.expiresAt || 0) <= now) accessTokenRefreshMap.delete(accessTokenId);
    }
  }

  function trackAccessToken(accessTokenId, refreshTokenId, accountUsername, expiresAt) {
    accessTokenRefreshMap.set(accessTokenId, {
      refreshTokenId,
      accountUsername,
      expiresAt,
    });
  }

  function getRefreshTokenIdForAccessToken(accessTokenId, now = Date.now()) {
    if (!accessTokenId) return null;
    pruneAccessTokenLinks(now);
    return accessTokenRefreshMap.get(accessTokenId)?.refreshTokenId || null;
  }

  function forgetAccessToken(accessTokenId) {
    if (!accessTokenId) return;
    accessTokenRefreshMap.delete(accessTokenId);
  }

  function buildUserPayload(account) {
    return {
      username: account.username,
      displayName: account.display_name || account.username,
      role: account.role || 'user',
      email: account.email || null,
      emailVerifiedAt: account.email_verified_at || null,
      emailPending: account.email_pending || null,
      totpEnabledAt: account.totp_enabled_at || null,
      pendingDeleteAt: account.pending_delete_at || null,
    };
  }

  function issueSession({
    account,
    deviceLabel = null,
    ip = null,
    userAgent = null,
    familyId = null,
    now = Date.now(),
  }) {
    const accessTokenId = crypto.randomUUID();
    const accessToken = createAuthToken({
      username: account.username,
      secret: config.authSecret,
      ttlMs: config.accessTokenTtlMs,
      tokenVersion: account.token_version || 1,
      role: account.role || 'user',
      tokenId: accessTokenId,
    });

    const refreshSecret = crypto.randomBytes(32).toString('base64url');
    const refreshTokenId = crypto.randomUUID();
    const refreshFamilyId = familyId || refreshTokenId;
    const accessTokenExpiresAt = now + config.accessTokenTtlMs;
    db.insertRefreshToken({
      tokenId: refreshTokenId,
      tokenHash: hashOpaqueTokenSecret(refreshSecret),
      accountUsername: account.username,
      familyId: refreshFamilyId,
      accountTokenVersionAtIssue: account.token_version || 1,
      deviceLabel,
      ip,
      userAgent,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + config.refreshTokenTtlMs,
    });
    trackAccessToken(accessTokenId, refreshTokenId, account.username, accessTokenExpiresAt);

    return {
      accessToken,
      accessTokenId,
      accessTokenExpiresAt,
      refreshToken: buildRefreshTokenWire(refreshTokenId, refreshSecret),
      refreshTokenId,
      familyId: refreshFamilyId,
      user: buildUserPayload(account),
    };
  }

  function refreshSession({ refreshToken, ip = null, userAgent = null, now = Date.now() }) {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) return { ok: false, code: 'invalid_refresh', message: 'Oturum yenilenemedi.' };

    const row = db.getRefreshToken(parsed.tokenId);
    if (!row) return { ok: false, code: 'invalid_refresh', message: 'Oturum yenilenemedi.' };

    const candidateHash = hashOpaqueTokenSecret(parsed.secret);
    const actualHash = Buffer.from(candidateHash, 'utf8');
    const expectedHash = Buffer.from(row.token_hash, 'utf8');
    if (actualHash.length !== expectedHash.length || !crypto.timingSafeEqual(actualHash, expectedHash)) {
      return { ok: false, code: 'invalid_refresh', message: 'Oturum yenilenemedi.' };
    }

    if (row.expires_at <= now) {
      return { ok: false, code: 'expired_refresh', message: 'Oturum süresi doldu. Tekrar giriş yap.' };
    }
    if (row.revoked_at) {
      return { ok: false, code: 'revoked_refresh', message: 'Oturum kapatılmış. Tekrar giriş yap.' };
    }

    if (row.replaced_by_token_id) {
      db.revokeRefreshFamily(row.family_id, now);
      db.bumpTokenVersion(row.account_username);
      forceDisconnectUser(row.account_username, 'refresh_reuse_detected');
      audit.record('refresh_reuse_detected', {
        actorUsername: row.account_username,
        ip,
        userAgent,
        metadata: {
          familyId: row.family_id,
          tokenId: row.token_id,
        },
      });
      return {
        ok: false,
        code: 'refresh_reuse_detected',
        message: 'Oturum güvenlik nedeniyle kapatıldı. Tekrar giriş yap.',
      };
    }

    const account = db.getAccount(row.account_username);
    if (!account || account.disabled_at) {
      return { ok: false, code: 'account_unavailable', message: 'Hesap kullanılamıyor. Tekrar giriş yap.' };
    }
    if ((account.token_version || 1) !== row.account_token_version_at_issue) {
      return { ok: false, code: 'stale_session', message: 'Oturum güncelliğini kaybetti. Tekrar giriş yap.' };
    }

    const next = issueSession({
      account,
      deviceLabel: row.device_label,
      ip,
      userAgent,
      familyId: row.family_id,
      now,
    });
    db.markRefreshReplaced(row.token_id, next.refreshTokenId, now);

    return {
      ok: true,
      ...next,
    };
  }

  function revokeSession({
    username,
    accessTokenId = null,
    accessTokenExpiresAt = null,
    refreshToken = null,
    now = Date.now(),
  }) {
    if (accessTokenId && Number.isFinite(accessTokenExpiresAt)) {
      db.revokeAccessToken(accessTokenId, accessTokenExpiresAt);
      forgetAccessToken(accessTokenId);
    }

    if (refreshToken) {
      const parsed = parseRefreshToken(refreshToken);
      if (parsed) {
        const row = db.getRefreshToken(parsed.tokenId);
        if (row && row.account_username === username) {
          db.revokeRefreshToken(parsed.tokenId, now);
        }
      }
    }
  }

  function revokeAllSessionsForUser({
    username,
    accessTokenId = null,
    accessTokenExpiresAt = null,
    now = Date.now(),
  }) {
    db.bumpTokenVersion(username);
    db.revokeAllRefreshTokensForUser(username, now);
    if (accessTokenId && Number.isFinite(accessTokenExpiresAt)) {
      db.revokeAccessToken(accessTokenId, accessTokenExpiresAt);
      forgetAccessToken(accessTokenId);
    }
  }

  return {
    buildRefreshTokenWire,
    buildUserPayload,
    forgetAccessToken,
    getRefreshTokenIdForAccessToken,
    hashOpaqueTokenSecret,
    issueSession,
    parseRefreshToken,
    pruneAccessTokenLinks,
    refreshSession,
    revokeAllSessionsForUser,
    revokeSession,
  };
}

module.exports = {
  buildRefreshTokenWire,
  createSessionManager,
  hashOpaqueTokenSecret,
  parseRefreshToken,
};
