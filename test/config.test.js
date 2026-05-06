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
