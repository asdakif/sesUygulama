'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function createIsolatedServer(prefix = 'sesapp-2fa-') {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.REGISTRATION_INVITE = 'test-invite';
  process.env.AUTH_SECRET = 'test-secret-key-that-is-at-least-32-bytes-long';
  process.env.EMAIL_PROVIDER = 'noop';
  process.env.EMAIL_ALLOW_NOOP = 'true';
  process.env.SESAPP_DB_FILE = path.join(tempDir, 'chat-data.sqlite');
  process.env.SESAPP_DATA_FILE = path.join(tempDir, 'chat-data.json');

  const { startServer, stopServer } = require('../../server');
  const { getNoopOutbox, resetNoopOutbox } = require('../../server/auth/email');
  const { generateTotpCode } = require('../../server/auth');

  return {
    tempDir,
    startServer,
    stopServer,
    getNoopOutbox,
    resetNoopOutbox,
    generateTotpCode,
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

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

async function completePendingAuth({
  baseUrl,
  pendingToken,
  generateTotpCode,
  secret = null,
  timeOffsetMs = 0,
}) {
  if (!pendingToken) throw new Error('pending token missing');

  if (!secret) {
    const enroll = await postJson(baseUrl, '/api/auth/2fa/enroll', {}, {
      Authorization: `Bearer ${pendingToken}`,
    });
    if (!enroll.response.ok) throw new Error(`2fa enroll failed: ${enroll.response.status}`);

    const nextSecret = enroll.payload.secret_b32;
    const confirm = await postJson(baseUrl, '/api/auth/2fa/enroll/confirm', {
      code: generateTotpCode(nextSecret, Date.now() + timeOffsetMs),
    }, {
      Authorization: `Bearer ${pendingToken}`,
    });
    return {
      enroll,
      confirm,
      secret: nextSecret,
      recoveryCodes: enroll.payload.recovery_codes || [],
    };
  }

  const verify = await postJson(baseUrl, '/api/auth/2fa/verify', {
    code: generateTotpCode(secret, Date.now() + timeOffsetMs),
  }, {
    Authorization: `Bearer ${pendingToken}`,
  });
  return {
    verify,
    secret,
    recoveryCodes: [],
  };
}

async function registerAndEnroll({
  baseUrl,
  username,
  email,
  password,
  inviteCode,
  generateTotpCode,
}) {
  const register = await postJson(baseUrl, '/api/auth/register', {
    username,
    email,
    password,
    inviteCode,
  });
  if (!register.response.ok) throw new Error(`register failed: ${register.response.status}`);

  const finalized = await completePendingAuth({
    baseUrl,
    pendingToken: register.payload.pending_token,
    generateTotpCode,
  });
  if (!finalized.confirm?.response?.ok) {
    throw new Error(`2fa confirm failed: ${finalized.confirm?.response?.status}`);
  }

  return {
    register,
    accessToken: finalized.confirm.payload.access_token,
    refreshToken: finalized.confirm.payload.refresh_token,
    secret: finalized.secret,
    recoveryCodes: finalized.recoveryCodes,
  };
}

module.exports = {
  completePendingAuth,
  createIsolatedServer,
  postJson,
  registerAndEnroll,
};
