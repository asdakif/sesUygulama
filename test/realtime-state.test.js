'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRealtimeState } = require('../server/realtime-state');

function createMockIo() {
  const events = [];
  return {
    events,
    emit(event, payload) {
      events.push({ room: null, event, payload });
    },
    to(room) {
      return {
        emit(event, payload) {
          events.push({ room, event, payload });
        },
      };
    },
    sockets: {
      sockets: new Map(),
    },
  };
}

function createMockSocket(id, events) {
  return {
    id,
    joined: [],
    left: [],
    leave(room) {
      this.left.push(room);
    },
    join(room) {
      this.joined.push(room);
    },
    to(room) {
      return {
        emit(event, payload) {
          events.push({ room, event, payload, fromSocketId: id });
        },
      };
    },
    emit(event, payload) {
      events.push({ room: `socket:${id}`, event, payload });
    },
  };
}

test('realtime state removes sockets from voice rooms and broadcasts updates', () => {
  const io = createMockIo();
  const state = createRealtimeState({ io, defaultVoiceRooms: ['sesli-genel'] });
  const socket = createMockSocket('socket-1', io.events);

  state.voiceRooms.get('sesli-genel').set('socket-1', { username: 'akif' });
  io.sockets.sockets.set('socket-1', socket);

  state.leaveAllVoiceRooms(socket);

  assert.equal(state.voiceRooms.get('sesli-genel').size, 0);
  assert.deepEqual(socket.left, ['voice:sesli-genel']);
  assert.ok(io.events.some((entry) => entry.event === 'voice_peer_left'));
  assert.ok(io.events.some((entry) => entry.event === 'voice_rooms_state'));
});

test('realtime state advances music queue and emits new payload', () => {
  const io = createMockIo();
  const state = createRealtimeState({ io, defaultVoiceRooms: ['sesli-genel'] });

  state.musicState.set('sesli-genel', {
    current: null,
    queue: [
      { trackUrl: 'a', title: 'A', thumbnail: '', addedBy: 'akif' },
      { trackUrl: 'b', title: 'B', thumbnail: '', addedBy: 'mehmet' },
    ],
    isPlaying: false,
    startedAt: 0,
    elapsed: 0,
  });

  state.advanceMusicQueue('sesli-genel');

  const payload = state.getMusicPayload('sesli-genel');
  assert.equal(payload.current.title, 'A');
  assert.equal(payload.queue.length, 1);
  assert.equal(payload.isPlaying, true);
  assert.ok(io.events.some((entry) => entry.room === 'voice:sesli-genel' && entry.event === 'music_state'));
});
