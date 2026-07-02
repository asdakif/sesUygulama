'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  syncSocketAuthToken,
  recoverInvalidSessionConnectError,
} = require('../public/socket-auth-recovery');

test('syncSocketAuthToken updates the handshake token and preserves auth fields', () => {
  const socket = {
    auth: {
      token: 'expired-token',
      deviceId: 'device-1',
    },
  };

  syncSocketAuthToken(socket, 'fresh-token');

  assert.deepEqual(socket.auth, {
    token: 'fresh-token',
    deviceId: 'device-1',
  });
});

test('recoverInvalidSessionConnectError retries refresh and recovers invalid_session reconnects', async () => {
  const events = [];
  let bannerHidden = 0;
  let recoverCalls = 0;

  const recovered = await recoverInvalidSessionConnectError({
    err: { data: { code: 'invalid_session' } },
    tryRecoverSocketSession: async () => {
      recoverCalls += 1;
      return true;
    },
    recordRealtimeDebug: (event, meta) => events.push({ event, meta }),
    hideConnectionBanner: () => {
      bannerHidden += 1;
    },
  });

  assert.equal(recovered, true);
  assert.equal(recoverCalls, 1);
  assert.equal(bannerHidden, 1);
  assert.deepEqual(events, [
    {
      event: 'socket_connect_error_recovered',
      meta: { code: 'invalid_session' },
    },
  ]);
});

test('recoverInvalidSessionConnectError ignores non-session errors and failed recovery attempts', async () => {
  const events = [];
  let bannerHidden = 0;
  let recoverCalls = 0;

  const nonSessionRecovered = await recoverInvalidSessionConnectError({
    err: { data: { code: 'transport_error' } },
    tryRecoverSocketSession: async () => {
      recoverCalls += 1;
      return true;
    },
    recordRealtimeDebug: (event, meta) => events.push({ event, meta }),
    hideConnectionBanner: () => {
      bannerHidden += 1;
    },
  });

  const failedRecovery = await recoverInvalidSessionConnectError({
    err: { data: { code: 'invalid_session' } },
    tryRecoverSocketSession: async () => {
      recoverCalls += 1;
      return false;
    },
    recordRealtimeDebug: (event, meta) => events.push({ event, meta }),
    hideConnectionBanner: () => {
      bannerHidden += 1;
    },
  });

  assert.equal(nonSessionRecovered, false);
  assert.equal(failedRecovery, false);
  assert.equal(recoverCalls, 1);
  assert.equal(bannerHidden, 0);
  assert.deepEqual(events, []);
});
