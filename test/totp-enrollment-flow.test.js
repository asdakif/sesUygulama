'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createIsolatedServer,
  postJson,
} = require('./helpers/integration-auth');

test('pending token enrollment rejects bad code and finalizes with a good code', async (t) => {
  const harness = createIsolatedServer('sesapp-totp-enroll-', { mfaMethod: 'totp' });
  t.after(async () => {
    await harness.stopServer().catch(() => {});
    harness.cleanup();
  });

  const address = await harness.startServer({ port: 0, host: '127.0.0.1', silent: true });
  const port = typeof address === 'object' && address ? address.port : 3000;
  const baseUrl = `http://127.0.0.1:${port}`;

  const register = await postJson(baseUrl, '/api/auth/register', {
    username: `totp_${Date.now()}`,
    email: `totp_${Date.now()}@example.com`,
    password: 'Secret123!totp',
    inviteCode: process.env.REGISTRATION_INVITE,
  });
  assert.equal(register.response.status, 201);
  assert.ok(register.payload.pending_token);

  const enroll = await postJson(baseUrl, '/api/auth/2fa/enroll', {}, {
    Authorization: `Bearer ${register.payload.pending_token}`,
  });
  assert.equal(enroll.response.status, 200);
  assert.ok(enroll.payload.secret_b32);
  assert.equal(Array.isArray(enroll.payload.recovery_codes), true);
  assert.equal(enroll.payload.recovery_codes.length, 10);

  const badConfirm = await postJson(baseUrl, '/api/auth/2fa/enroll/confirm', {
    code: '000000',
  }, {
    Authorization: `Bearer ${register.payload.pending_token}`,
  });
  assert.equal(badConfirm.response.status, 401);

  const goodConfirm = await postJson(baseUrl, '/api/auth/2fa/enroll/confirm', {
    code: harness.generateTotpCode(enroll.payload.secret_b32),
  }, {
    Authorization: `Bearer ${register.payload.pending_token}`,
  });
  assert.equal(goodConfirm.response.status, 200);
  assert.ok(goodConfirm.payload.access_token);
  assert.ok(goodConfirm.payload.refresh_token);

  const meRes = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${goodConfirm.payload.access_token}` },
  });
  assert.equal(meRes.status, 200);
  const mePayload = await meRes.json();
  assert.ok(mePayload.user?.totpEnabledAt);
});
