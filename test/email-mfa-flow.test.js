'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createIsolatedServer,
  postJson,
} = require('./helpers/integration-auth');

test('email MFA sends a code on register and login, and resend rotates the code', async (t) => {
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
  assert.deepEqual(register.payload.requires, ['email_code']);
  assert.ok(register.payload.pending_token);

  const firstCodeMail = harness.getNoopOutbox().find((item) => item.kind === 'login_code' && item.to === email);
  assert.ok(firstCodeMail?.code);

  const verify = await postJson(baseUrl, '/api/auth/2fa/verify', {
    code: firstCodeMail.code,
  }, {
    Authorization: `Bearer ${register.payload.pending_token}`,
  });
  assert.equal(verify.response.status, 200);
  assert.ok(verify.payload.access_token);
  assert.ok(verify.payload.refresh_token);

  const meRes = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${verify.payload.access_token}` },
  });
  assert.equal(meRes.status, 200);
  const mePayload = await meRes.json();
  assert.equal(mePayload.user?.email, email);
  assert.ok(mePayload.user?.emailVerifiedAt);
  assert.ok(mePayload.user?.mfaEnabledAt);

  harness.resetNoopOutbox();
  const login = await postJson(baseUrl, '/api/auth/login', {
    username,
    password,
  });
  assert.equal(login.response.status, 200);
  assert.deepEqual(login.payload.requires, ['email_code']);
  assert.ok(login.payload.pending_token);

  const loginCodeMail = harness.getNoopOutbox().find((item) => item.kind === 'login_code' && item.to === email);
  assert.ok(loginCodeMail?.code);

  const resend = await postJson(baseUrl, '/api/auth/2fa/resend', {}, {
    Authorization: `Bearer ${login.payload.pending_token}`,
  });
  assert.equal(resend.response.status, 200);

  const loginMails = harness.getNoopOutbox().filter((item) => item.kind === 'login_code' && item.to === email);
  assert.equal(loginMails.length, 2);
  assert.notEqual(loginMails[0].code, loginMails[1].code);

  const oldCodeAttempt = await postJson(baseUrl, '/api/auth/2fa/verify', {
    code: loginMails[0].code,
  }, {
    Authorization: `Bearer ${login.payload.pending_token}`,
  });
  assert.equal(oldCodeAttempt.response.status, 401);
  assert.equal(oldCodeAttempt.payload.code, 'invalid_email_code');

  const finalVerify = await postJson(baseUrl, '/api/auth/2fa/verify', {
    code: loginMails[1].code,
  }, {
    Authorization: `Bearer ${login.payload.pending_token}`,
  });
  assert.equal(finalVerify.response.status, 200);
  assert.ok(finalVerify.payload.access_token);
});
