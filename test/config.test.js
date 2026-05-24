'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../server/config');

test('parseIceServers accepts string and array urls', () => {
  const parsed = config.parseIceServers(JSON.stringify([
    { urls: 'stun:example.com:3478' },
    {
      urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:5349?transport=tcp'],
      username: 'demo-user',
      credential: 'demo-pass',
    },
  ]));

  assert.deepEqual(parsed, [
    { urls: 'stun:example.com:3478' },
    {
      urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:5349?transport=tcp'],
      username: 'demo-user',
      credential: 'demo-pass',
    },
  ]);
});

test('parseIceServers ignores invalid entries and rejects non-arrays', () => {
  assert.equal(config.parseIceServers('{"urls":"stun:example.com"}'), null);
  assert.deepEqual(
    config.parseIceServers(JSON.stringify([
      { urls: '' },
      { urls: ['   ', 'stun:valid.example.com:3478'] },
      null,
    ])),
    [{ urls: ['stun:valid.example.com:3478'] }],
  );
});

test('buildManagedTurnIceServers creates ICE config from TURN env vars', () => {
  const iceServers = config.buildManagedTurnIceServers({
    TURN_HOSTS: 'turn-1.example.com, turn-2.example.com',
    TURN_USERNAME: 'turn-user',
    TURN_PASSWORD: 'turn-pass',
    TURN_PORT: '3478',
    TURNS_PORT: '5349',
  });

  assert.deepEqual(iceServers, [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: [
        'turn:turn-1.example.com:3478',
        'turn:turn-1.example.com:3478?transport=tcp',
        'turns:turn-1.example.com:5349?transport=tcp',
        'turn:turn-2.example.com:3478',
        'turn:turn-2.example.com:3478?transport=tcp',
        'turns:turn-2.example.com:5349?transport=tcp',
      ],
      username: 'turn-user',
      credential: 'turn-pass',
    },
  ]);
});

test('buildManagedTurnIceServers returns null without complete credentials', () => {
  assert.equal(config.buildManagedTurnIceServers({
    TURN_HOST: 'turn.example.com',
    TURN_USERNAME: 'turn-user',
  }), null);
});
