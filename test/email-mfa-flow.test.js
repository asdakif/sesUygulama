'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createIsolatedServer,
  postJson,
} = require('./helpers/integration-auth');

test('register issues tokens immediately and login works without email code', async (t) => {
  const harness = createIsolatedServer('sesapp-email-mfa-');
  t.after(async () => {
    await harness.stopServer().catch(() => {});
    harness.cleanup();
  });

  const address = await harness.startServer({ port: 0, host: '127.0.0.1', silent: true });
  const port = typeof address === 'object' && address ? address.port : 3000;
  const baseUrl = `http://127.0.0.1:${port}`;
  const stamp = Date.now().toString(36);
  const username = `mail_${stamp}`;
  const email = `${username}@example.com`;
  const password = 'Secret123!mail';

  harness.resetNoopOutbox();
  const register = await postJson(baseUrl, '/api/auth/register', {
    username,
    email,
    password,
    inviteCode: process.env.REGISTRATION_INVITE,
  });
  assert.equal(register.response.status, 201);
  assert.ok(register.payload.access_token);
  assert.ok(register.payload.refresh_token);
  assert.equal(register.payload.pending_token || null, null);

  const codeMail = harness.getNoopOutbox().find((item) => item.kind === 'login_code' && item.to === email);
  assert.equal(codeMail || null, null);

  const meRes = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${register.payload.access_token}` },
  });
  assert.equal(meRes.status, 200);
  const mePayload = await meRes.json();
  assert.equal(mePayload.user?.email, email);
  assert.ok(mePayload.user?.emailVerifiedAt);

  harness.resetNoopOutbox();
  const login = await postJson(baseUrl, '/api/auth/login', {
    username,
    password,
  });
  assert.equal(login.response.status, 200);
  assert.ok(login.payload.access_token);
  assert.ok(login.payload.refresh_token);
  assert.equal(login.payload.pending_token || null, null);
  const loginCodeMail = harness.getNoopOutbox().find((item) => item.kind === 'login_code' && item.to === email);
  assert.equal(loginCodeMail || null, null);
});
