'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSoundboard } = require('../server/soundboard');

function setup() {
  const events = [];
  const alice = { id: 'alice-socket' };
  const bob = { id: 'bob-socket' };
  const connectedUsers = new Map([
    [alice.id, { username: 'alice' }],
    [bob.id, { username: 'bob' }],
  ]);
  const voiceRooms = new Map([
    ['general', new Map([[alice.id, {}], [bob.id, {}]])],
    ['other', new Map()],
  ]);
  let time = 100_000;
  const board = createSoundboard({
    connectedUsers,
    voiceRooms,
    now: () => time,
    io: { to: (room) => ({ emit: (event, payload) => events.push({ room, event, payload }) }) },
  });
  return { board, alice, bob, connectedUsers, voiceRooms, events, advance: (ms) => { time += ms; } };
}

test('soundboard routes only to the actual voice room and uses the authenticated name', () => {
  const { board, alice, events } = setup();
  const result = board.play(alice, { clipId: 'selamun-aleykum', room: 'other', username: 'forged', src: 'https://example.com/audio' });
  assert.equal(result.ok, true);
  assert.deepEqual(events, [{
    room: 'voice:general',
    event: 'soundboard_play',
    payload: { clipId: 'selamun-aleykum', room: 'general', username: 'alice', cooldownMs: 3000 },
  }]);
});

test('soundboard rejects unknown clips, malformed payloads and users outside voice rooms', () => {
  const { board, alice, voiceRooms, events } = setup();
  for (const payload of [undefined, null, {}, { clipId: '../../server.js' }, { clipId: {} }]) {
    assert.equal(board.play(alice, payload).ok, false);
  }
  assert.equal(board.play({ id: 'stranger' }, { clipId: 'aleykum-selam' }).ok, false);
  voiceRooms.get('general').delete(alice.id);
  assert.equal(board.play(alice, { clipId: 'aleykum-selam' }).ok, false);
  assert.equal(events.length, 0);
});

test('soundboard prevents overlapping clips even when another member sends the next one', () => {
  const { board, alice, bob, events, advance } = setup();
  const first = board.play(alice, { clipId: 'selamun-aleykum' });
  assert.equal(first.ok, true);
  assert.equal(first.cooldownMs, 3000);
  advance(1000);
  const blocked = board.play(bob, { clipId: 'aleykum-selam' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryAfterMs, first.cooldownMs - 1000);
  assert.equal(events.length, 1);
  advance(blocked.retryAfterMs);
  assert.equal(board.play(bob, { clipId: 'aleykum-selam' }).ok, true);
  assert.equal(events.length, 2);
});

test('changing voice rooms cannot bypass the sender cooldown; independent rooms can play', () => {
  const { board, alice, bob, voiceRooms, events } = setup();
  board.play(alice, { clipId: 'selamun-aleykum' });
  voiceRooms.get('general').delete(alice.id);
  voiceRooms.get('other').set(alice.id, {});
  assert.equal(board.play(alice, { clipId: 'aleykum-selam' }).ok, false);
  voiceRooms.get('general').delete(bob.id);
  voiceRooms.get('other').set(bob.id, {});
  assert.equal(board.play(bob, { clipId: 'aleykum-selam' }).ok, true);
  assert.deepEqual(events.map((event) => event.room), ['voice:general', 'voice:other']);
});
