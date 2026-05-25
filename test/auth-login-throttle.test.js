'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createLoginThrottle } = require('../server/auth');

function createMockDb() {
  const attempts = new Map();
  const accountState = new Map();
  return {
    attempts,
    accountState,
    clearLoginAttempt(bucketKey) {
      attempts.delete(bucketKey);
    },
    getLoginAttempt(bucketKey) {
      return attempts.get(bucketKey) || null;
    },
    pruneLoginAttempts() {},
    setAccountLoginSecurity(username, payload) {
      accountState.set(username, payload);
    },
    upsertLoginAttempt(payload) {
      attempts.set(payload.bucketKey, {
        bucket_key: payload.bucketKey,
        attempts: payload.attempts,
        first_attempt_at: payload.firstAttemptAt,
        last_attempt_at: payload.lastAttemptAt,
        locked_until: payload.lockedUntil,
      });
    },
  };
}

test('login throttle applies delay and lockout after repeated failures', () => {
  const db = createMockDb();
  const auditEvents = [];
  const throttle = createLoginThrottle({
    db,
    audit: {
      record(event, payload) {
        auditEvents.push({ event, payload });
      },
    },
  });

  const now = Date.now();
  for (let index = 0; index < 9; index += 1) {
    const result = throttle.registerFailure({
      username: 'akif',
      ip: '127.0.0.1',
      now: now + index,
    });
    if (index < 2) assert.equal(result.delayMs, 0);
  }

  const locked = throttle.registerFailure({
    username: 'akif',
    ip: '127.0.0.1',
    now: now + 10,
  });
  assert.ok(locked.lockedUntil > now);
  assert.ok(locked.retryAfterMs > 0);

  const blocked = throttle.beginAttempt({
    username: 'akif',
    ip: '127.0.0.1',
    now: now + 11,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'account_locked');
  assert.equal(auditEvents.some((event) => event.event === 'lockout_triggered'), true);
});
