'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function resetModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {}
}

function createIsolatedServer(prefix = 'sesapp-auth-') {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.REGISTRATION_INVITE = 'test-invite';
  process.env.AUTH_SECRET = 'test-secret-key-that-is-at-least-32-bytes-long';
  process.env.EMAIL_PROVIDER = 'noop';
  process.env.EMAIL_ALLOW_NOOP = 'true';
  process.env.SESAPP_DB_FILE = path.join(tempDir, 'chat-data.sqlite');
  process.env.SESAPP_DATA_FILE = path.join(tempDir, 'chat-data.json');

  resetModule('../../server');
  resetModule('../../database');
  resetModule('../../server/config');
  resetModule('../../server/auth');
  resetModule('../../server/auth/email');

  const { startServer, stopServer } = require('../../server');
  const { getNoopOutbox, resetNoopOutbox } = require('../../server/auth/email');

  return {
    tempDir,
    startServer,
    stopServer,
    getNoopOutbox,
    resetNoopOutbox,
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
  pendingPayload = {},
  getNoopOutbox = null,
  email = '',
}) {
  if (!pendingToken) throw new Error('pending token missing');
  const requirement = Array.isArray(pendingPayload.requires) ? pendingPayload.requires[0] : '';
  if (requirement !== 'email_code') {
    throw new Error(`unsupported pending auth requirement: ${requirement || 'none'}`);
  }

  const outbox = typeof getNoopOutbox === 'function' ? getNoopOutbox() : [];
  const mail = [...outbox].reverse().find((item) => item.kind === 'login_code' && (!email || item.to === email));
  if (!mail?.code) throw new Error('email code was not captured');
  const verify = await postJson(baseUrl, '/api/auth/2fa/verify', {
    code: mail.code,
  }, {
    Authorization: `Bearer ${pendingToken}`,
  });
  return { verify };
}

async function registerAndCompleteMfa({
  baseUrl,
  username,
  email,
  password,
  inviteCode,
  getNoopOutbox = null,
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
    pendingPayload: register.payload,
    getNoopOutbox,
    email,
  });
  const authResponse = finalized.verify?.response;
  if (!authResponse?.ok) {
    throw new Error(`email verification failed: ${authResponse?.status}`);
  }
  const authPayload = finalized.verify?.payload;

  return {
    register,
    accessToken: authPayload.access_token,
    refreshToken: authPayload.refresh_token,
  };
}

module.exports = {
  completePendingAuth,
  createIsolatedServer,
  postJson,
  registerAndCompleteMfa,
};
