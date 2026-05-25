'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createRealtimeState } = require('../server/realtime-state');

function createSocket(username = null) {
  return {
    data: username ? { auth: { username } } : {},
    emitted: [],
    disconnected: false,
    emit(event, payload) {
      this.emitted.push({ event, payload });
    },
    disconnect(force) {
      this.disconnected = force;
    },
  };
}

test('forceDisconnectUser disconnects all sockets for the matching username', () => {
  const aliceA = createSocket('akif');
  const aliceB = createSocket('akif');
  const bob = createSocket('mehmet');
  const anonymous = createSocket();

  const io = {
    of() {
      return {
        sockets: new Map([
          ['socket-a', aliceA],
          ['socket-b', aliceB],
          ['socket-c', bob],
          ['socket-d', anonymous],
        ]),
      };
    },
  };

  const realtime = createRealtimeState({
    io,
    defaultVoiceRooms: ['sesli-genel'],
  });

  const disconnected = realtime.forceDisconnectUser(
    'akif',
    'refresh_reuse_detected',
    'Oturumun sonlandırıldı.',
  );

  assert.equal(disconnected, 2);
  assert.equal(aliceA.disconnected, true);
  assert.equal(aliceB.disconnected, true);
  assert.equal(bob.disconnected, false);
  assert.equal(anonymous.disconnected, false);
  assert.deepEqual(aliceA.emitted[0], {
    event: 'auth_error',
    payload: {
      code: 'refresh_reuse_detected',
      message: 'Oturumun sonlandırıldı.',
    },
  });
  assert.deepEqual(aliceB.emitted[0], aliceA.emitted[0]);
});
