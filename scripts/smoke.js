'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.REGISTRATION_INVITE ||= 'test-invite';
process.env.AUTH_SECRET ||= 'test-secret-key-that-is-at-least-32-bytes-long';
process.env.EMAIL_PROVIDER ||= 'noop';
process.env.EMAIL_ALLOW_NOOP ||= 'true';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sesapp-smoke-'));
process.env.SESAPP_DB_FILE = path.join(tempDir, 'chat-data.sqlite');
process.env.SESAPP_DATA_FILE = path.join(tempDir, 'chat-data.json');

const { startServer, stopServer } = require('../server');
const { getNoopOutbox, resetNoopOutbox } = require('../server/auth/email');

async function postJson(baseUrl, pathName, body, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {}
  return { response, payload };
}

async function finalizePendingAuth({
  baseUrl,
  pendingToken,
  pendingPayload = {},
}) {
  if (!pendingToken) throw new Error('Pending token missing');
  const requirement = Array.isArray(pendingPayload.requires) ? pendingPayload.requires[0] : '';

  if (requirement !== 'email_code') {
    throw new Error(`Unexpected MFA requirement: ${requirement || 'none'}`);
  }

  const mail = [...getNoopOutbox()].reverse().find((item) => item.kind === 'login_code');
  if (!mail?.code) throw new Error('Email login code was not captured');
  const verify = await postJson(baseUrl, '/api/auth/2fa/verify', {
    code: mail.code,
  }, {
    Authorization: `Bearer ${pendingToken}`,
  });
  if (!verify.response.ok) throw new Error(`Email code verify failed: ${verify.response.status}`);
  return {
    authPayload: verify.payload,
  };
}

async function main() {
  const address = await startServer({ port: 0, host: '127.0.0.1', silent: true });
  const port = typeof address === 'object' && address ? address.port : 3000;
  const baseUrl = `http://127.0.0.1:${port}`;
  const username = `smoke_${Date.now()}`;
  const guestUsername = `g${Date.now().toString().slice(-8)}`;
  const email = `${username}@example.com`;
  const password = 'Secret123!smoke';
  const nextPassword = 'Secret456!reset';

  resetNoopOutbox();
  const registerRes = await postJson(baseUrl, '/api/auth/register', {
    username,
    email,
    password,
    inviteCode: process.env.REGISTRATION_INVITE,
  });
  if (!registerRes.response.ok) throw new Error(`Register failed: ${registerRes.response.status}`);
  const registerPayload = registerRes.payload;
  const pendingToken = registerPayload.pending_token;
  if (!pendingToken) throw new Error('Register response missing pending token');

  const enrolled = await finalizePendingAuth({ baseUrl, pendingToken, pendingPayload: registerPayload });
  let accessToken = enrolled.authPayload.access_token || enrolled.authPayload.token;
  let refreshToken = enrolled.authPayload.refresh_token;
  if (!accessToken || !refreshToken) throw new Error('Enrollment response missing access/refresh tokens');

  const meRes = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!meRes.ok) throw new Error(`Auth me failed: ${meRes.status}`);
  const mePayload = await meRes.json();
  if (mePayload?.user?.role !== 'admin') {
    throw new Error('First account should be bootstrapped as admin');
  }
  if (!mePayload?.user?.emailVerifiedAt) {
    throw new Error('Primary account email should be verified after MFA');
  }

  const createInviteRes = await postJson(baseUrl, '/api/admin/invites', {
    label: 'smoke invite',
    max_uses: 1,
    ttl_hours: 1,
  }, {
    Authorization: `Bearer ${accessToken}`,
  });
  if (!createInviteRes.response.ok) throw new Error(`Create invite failed: ${createInviteRes.response.status}`);
  const invitePayload = createInviteRes.payload;
  if (!invitePayload?.code) throw new Error('Invite code missing from admin create response');

  const invitedRegisterRes = await postJson(baseUrl, '/api/auth/register', {
    username: guestUsername,
    email: `${guestUsername}@example.com`,
    password: 'Secret123!guest',
    inviteCode: invitePayload.code,
  });
  if (!invitedRegisterRes.response.ok) throw new Error(`Invite registration failed: ${invitedRegisterRes.response.status}`);
  if (!invitedRegisterRes.payload?.pending_token) {
    throw new Error('Invited register response missing pending token');
  }
  await finalizePendingAuth({
    baseUrl,
    pendingToken: invitedRegisterRes.payload.pending_token,
    pendingPayload: invitedRegisterRes.payload,
  });

  const refreshRes = await postJson(baseUrl, '/api/auth/refresh', { refresh_token: refreshToken });
  if (!refreshRes.response.ok) throw new Error(`Refresh failed: ${refreshRes.response.status}`);
  const refreshPayload = refreshRes.payload;
  accessToken = refreshPayload.access_token;
  refreshToken = refreshPayload.refresh_token;
  if (!accessToken || !refreshToken) {
    throw new Error('Refresh response missing access/refresh tokens');
  }

  const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (logoutRes.status !== 204) throw new Error(`Logout failed: ${logoutRes.status}`);

  const revokedRes = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (revokedRes.status !== 401) {
    throw new Error(`Revoked token should fail, received ${revokedRes.status}`);
  }

  const revokedRefreshRes = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (revokedRefreshRes.ok) {
    throw new Error('Revoked refresh token should fail');
  }

  resetNoopOutbox();
  const forgotRes = await fetch(`${baseUrl}/api/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (forgotRes.status !== 204) throw new Error(`Forgot password failed: ${forgotRes.status}`);

  const resetMail = getNoopOutbox().find((item) => item.kind === 'password_reset' && item.to === email);
  if (!resetMail?.resetUrl) throw new Error('Password reset email was not captured');
  const resetToken = new URL(resetMail.resetUrl).searchParams.get('token');
  if (!resetToken) throw new Error('Reset token missing from email');

  const resetRes = await postJson(baseUrl, '/api/auth/reset-password', {
    token: resetToken,
    new_password: nextPassword,
  });
  if (!resetRes.response.ok) throw new Error(`Reset password failed: ${resetRes.response.status}`);

  const secondResetRes = await postJson(baseUrl, '/api/auth/reset-password', {
    token: resetToken,
    new_password: 'Secret789!reuse',
  });
  if (secondResetRes.response.ok) throw new Error('Password reset token should be single use');

  const newLoginRes = await postJson(baseUrl, '/api/auth/login', {
    username,
    password: nextPassword,
  });
  if (!newLoginRes.response.ok) throw new Error(`Login after reset failed: ${newLoginRes.response.status}`);
  if (!newLoginRes.payload?.access_token || !newLoginRes.payload?.refresh_token) {
    throw new Error('Login after reset did not issue full session');
  }

  await stopServer();
  console.log('Smoke test passed.');
}

main().catch(async (err) => {
  try {
    await stopServer();
  } catch {}
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
