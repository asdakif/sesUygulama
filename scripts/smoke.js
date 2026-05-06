'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PASSWORD ||= 'test';
process.env.AUTH_SECRET ||= 'test-secret';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sesapp-smoke-'));
process.env.SESAPP_DB_FILE = path.join(tempDir, 'chat-data.sqlite');
process.env.SESAPP_DATA_FILE = path.join(tempDir, 'chat-data.json');

const { startServer, stopServer } = require('../server');

async function main() {
  const address = await startServer({ port: 0, host: '127.0.0.1', silent: true });
  const port = typeof address === 'object' && address ? address.port : 3000;
  const baseUrl = `http://127.0.0.1:${port}`;
  const username = `smoke-${Date.now()}`;
  const password = 'secret123';

  const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      inviteCode: process.env.PASSWORD,
    }),
  });
  if (!registerRes.ok) throw new Error(`Register failed: ${registerRes.status}`);
  const registerPayload = await registerRes.json();
  const token = registerPayload.token;

  const meRes = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!meRes.ok) throw new Error(`Auth me failed: ${meRes.status}`);

  const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (logoutRes.status !== 204) throw new Error(`Logout failed: ${logoutRes.status}`);

  const revokedRes = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (revokedRes.status !== 401) {
    throw new Error(`Revoked token should fail, received ${revokedRes.status}`);
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
