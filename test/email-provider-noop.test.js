'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createEmailService,
  getNoopOutbox,
  resetNoopOutbox,
} = require('../server/auth/email');

test('noop email provider captures password reset and verification emails', async () => {
  resetNoopOutbox();
  const service = createEmailService({
    provider: 'noop',
    config: {},
    logger: { info() {} },
  });

  await service.sendPasswordReset({
    to: 'akif@example.com',
    displayName: 'Akif',
    resetUrl: 'https://locast.app/reset-password?token=abc',
    expiresInMin: 60,
  });
  await service.sendEmailVerification({
    to: 'akif@example.com',
    displayName: 'Akif',
    verifyUrl: 'https://locast.app/confirm-email?token=def',
    expiresInMin: 60,
  });

  const outbox = getNoopOutbox();
  assert.equal(outbox.length, 2);
  assert.equal(outbox[0].kind, 'password_reset');
  assert.match(outbox[0].resetUrl, /reset-password\?token=abc/);
  assert.equal(outbox[1].kind, 'email_verification');
  assert.match(outbox[1].verifyUrl, /confirm-email\?token=def/);
});
