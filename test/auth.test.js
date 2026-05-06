'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createAuthToken,
  hashPassword,
  validatePassword,
  validateUsername,
  verifyAuthToken,
  verifyPassword,
} = require('../server/auth');

test('password hashing verifies correct and incorrect passwords', () => {
  const hash = hashPassword('super-secret');
  assert.equal(verifyPassword('super-secret', hash), true);
  assert.equal(verifyPassword('wrong-pass', hash), false);
});

test('auth token verifies and rejects tampering', () => {
  const token = createAuthToken({
    username: 'akif',
    secret: 'test-secret',
    ttlMs: 60_000,
  });
  assert.equal(verifyAuthToken(token, 'test-secret')?.username, 'akif');
  assert.ok(verifyAuthToken(token, 'test-secret')?.tokenId);

  const [payload, signature] = token.split('.');
  const tampered = `${payload}.${signature.slice(0, -1)}a`;
  assert.equal(verifyAuthToken(tampered, 'test-secret'), null);
});

test('auth validators enforce username and password bounds', () => {
  assert.equal(validateUsername('a').ok, false);
  assert.equal(validateUsername('akif').ok, true);
  assert.equal(validatePassword('12345').ok, false);
  assert.equal(validatePassword('123456').ok, true);
});
