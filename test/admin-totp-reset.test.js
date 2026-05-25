'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createIsolatedServer,
  postJson,
  registerAndEnroll,
} = require('./helpers/integration-auth');

test('admin can reset another user totp state and force re-enrollment', async (t) => {
  const harness = createIsolatedServer('sesapp-admin-totp-reset-');
  t.after(async () => {
    await harness.stopServer().catch(() => {});
    harness.cleanup();
  });

  const address = await harness.startServer({ port: 0, host: '127.0.0.1', silent: true });
  const port = typeof address === 'object' && address ? address.port : 3000;
  const baseUrl = `http://127.0.0.1:${port}`;
  const stamp = Date.now();

  const admin = await registerAndEnroll({
    baseUrl,
    username: `admin_${stamp}`,
    email: `admin_${stamp}@example.com`,
    password: 'Secret123!admin',
    inviteCode: process.env.REGISTRATION_INVITE,
    generateTotpCode: harness.generateTotpCode,
  });

  const createInvite = await postJson(baseUrl, '/api/admin/invites', {
    label: 'guest invite',
    max_uses: 1,
    ttl_hours: 1,
  }, {
    Authorization: `Bearer ${admin.accessToken}`,
  });
  assert.equal(createInvite.response.status, 201);
  assert.ok(createInvite.payload.code);

  const guest = await registerAndEnroll({
    baseUrl,
    username: `guest_${stamp}`,
    email: `guest_${stamp}@example.com`,
    password: 'Secret123!guest',
    inviteCode: createInvite.payload.code,
    generateTotpCode: harness.generateTotpCode,
  });

  const reset = await postJson(baseUrl, '/api/auth/2fa/reset', {
    username: `guest_${stamp}`,
  }, {
    Authorization: `Bearer ${admin.accessToken}`,
  });
  assert.equal(reset.response.status, 204);

  const guestMe = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${guest.accessToken}` },
  });
  assert.equal(guestMe.status, 401);

  const guestLogin = await postJson(baseUrl, '/api/auth/login', {
    username: `guest_${stamp}`,
    password: 'Secret123!guest',
  });
  assert.equal(guestLogin.response.status, 200);
  assert.ok(guestLogin.payload.pending_token);
  assert.deepEqual(guestLogin.payload.requires, ['totp_enroll']);
});
