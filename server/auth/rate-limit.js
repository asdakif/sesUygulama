'use strict';

const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_MS = 15 * 60 * 1000;
const WINDOW_MS = 60 * 60 * 1000;
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

function getDelayMs(attempts) {
  if (attempts >= 7) return 30_000;
  if (attempts === 6) return 15_000;
  if (attempts === 5) return 5_000;
  if (attempts === 4) return 2_000;
  if (attempts === 3) return 1_000;
  return 0;
}

function normalizeBucket(row, now) {
  if (!row) {
    return {
      attempts: 0,
      first_attempt_at: now,
      last_attempt_at: now,
      locked_until: null,
    };
  }

  if (now - row.first_attempt_at > WINDOW_MS) {
    return {
      attempts: 0,
      first_attempt_at: now,
      last_attempt_at: now,
      locked_until: row.locked_until && row.locked_until > now ? row.locked_until : null,
    };
  }

  return row;
}

function createLoginThrottle({ db, audit }) {
  function prune(now = Date.now()) {
    db.pruneLoginAttempts(now - PRUNE_AFTER_MS, now);
  }

  function resolveBuckets({ username, ip, now = Date.now() }) {
    const bucketKeys = [
      username ? `user:${username}` : null,
      ip ? `ip:${ip}` : null,
    ].filter(Boolean);
    const rows = bucketKeys.map((bucketKey) => ({
      bucketKey,
      row: normalizeBucket(db.getLoginAttempt(bucketKey), now),
    }));
    const activeLock = rows
      .map(({ row }) => row.locked_until)
      .filter((value) => Number.isFinite(value) && value > now)
      .sort((a, b) => b - a)[0];
    return {
      bucketKeys,
      rows,
      activeLock,
    };
  }

  function beginAttempt({ username, ip, now = Date.now() }) {
    prune(now);
    const state = resolveBuckets({ username, ip, now });
    if (state.activeLock) {
      return {
        ok: false,
        code: 'account_locked',
        retryAfterMs: state.activeLock - now,
      };
    }
    return { ok: true };
  }

  function registerFailure({ username, ip, now = Date.now(), actorUsername = null, userAgent = null }) {
    const state = resolveBuckets({ username, ip, now });
    let maxAttempts = 0;
    let lockTriggered = false;
    let lockedUntil = null;

    for (const { bucketKey, row } of state.rows) {
      const attempts = row.attempts + 1;
      maxAttempts = Math.max(maxAttempts, attempts);
      const nextLockedUntil = attempts >= LOCKOUT_THRESHOLD ? now + LOCKOUT_MS : null;
      if (nextLockedUntil) {
        lockTriggered = true;
        lockedUntil = Math.max(lockedUntil || 0, nextLockedUntil);
      }
      db.upsertLoginAttempt({
        bucketKey,
        attempts,
        firstAttemptAt: row.first_attempt_at || now,
        lastAttemptAt: now,
        lockedUntil: nextLockedUntil,
      });
    }

    if (username) {
      db.setAccountLoginSecurity(username, {
        failedLoginCount: maxAttempts,
        lockedUntil,
      });
    }

    if (lockTriggered) {
      audit.record('lockout_triggered', {
        actorUsername,
        targetUsername: username || actorUsername,
        ip,
        userAgent,
        metadata: { lockedUntil },
      });
    }

    return {
      delayMs: getDelayMs(maxAttempts),
      lockedUntil,
      retryAfterMs: lockedUntil ? lockedUntil - now : 0,
      maxAttempts,
    };
  }

  function registerSuccess({ username, ip }) {
    if (username) db.clearLoginAttempt(`user:${username}`);
    if (ip) db.clearLoginAttempt(`ip:${ip}`);
    if (username) {
      db.setAccountLoginSecurity(username, {
        failedLoginCount: 0,
        lockedUntil: null,
      });
    }
  }

  return {
    beginAttempt,
    prune,
    registerFailure,
    registerSuccess,
  };
}

module.exports = {
  LOCKOUT_MS,
  LOCKOUT_THRESHOLD,
  WINDOW_MS,
  createLoginThrottle,
  getDelayMs,
};
