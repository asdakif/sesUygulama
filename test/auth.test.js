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
  assert.equal(verifyPassword('super-secret', hash).ok, true);
  assert.equal(verifyPassword('wrong-pass', hash).ok, false);
});

test('auth token verifies and rejects tampering', () => {
  const token = createAuthToken({
    username: 'akif',
    secret: 'test-secret-key-that-is-at-least-32-bytes-long',
    ttlMs: 60_000,
    tokenVersion: 3,
    role: 'user',
  });
  assert.equal(verifyAuthToken(token, 'test-secret-key-that-is-at-least-32-bytes-long')?.username, 'akif');
  assert.equal(verifyAuthToken(token, 'test-secret-key-that-is-at-least-32-bytes-long')?.tokenVersion, 3);
  assert.ok(verifyAuthToken(token, 'test-secret-key-that-is-at-least-32-bytes-long')?.tokenId);

  const [payload, signature] = token.split('.');
  const tampered = `${payload}.${signature.slice(0, -1)}a`;
  assert.equal(verifyAuthToken(tampered, 'test-secret-key-that-is-at-least-32-bytes-long'), null);
});

test('auth validators enforce username and password bounds', () => {
  assert.equal(validateUsername('a').ok, false);
  assert.equal(validateUsername('Akif').username, 'akif');
  assert.equal(validatePassword('12345').ok, false);
  assert.equal(validatePassword('password123').ok, false);
  assert.equal(validatePassword('CokGuvclu!12345').ok, true);
});
