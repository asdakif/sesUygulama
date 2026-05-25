'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createIsolatedServer,
  postJson,
  registerAndEnroll,
} = require('./helpers/integration-auth');

test('refresh endpoint applies its dedicated per-ip rate limit', async (t) => {
  process.env.AUTH_REFRESH_RATE_MAX = '2';
  process.env.AUTH_REFRESH_RATE_WINDOW_MS = '60000';

  const harness = createIsolatedServer('sesapp-refresh-limit-');
  t.after(async () => {
    delete process.env.AUTH_REFRESH_RATE_MAX;
    delete process.env.AUTH_REFRESH_RATE_WINDOW_MS;
    await harness.stopServer().catch(() => {});
    harness.cleanup();
  });

  const address = await harness.startServer({ port: 0, host: '127.0.0.1', silent: true });
  const port = typeof address === 'object' && address ? address.port : 3000;
  const baseUrl = `http://127.0.0.1:${port}`;
  const suffix = Date.now().toString(36);

  const session = await registerAndEnroll({
    baseUrl,
    username: `rfl_${suffix}`,
    email: `rfl_${suffix}@example.com`,
    password: 'Secret123!limit',
    inviteCode: process.env.REGISTRATION_INVITE,
    generateTotpCode: harness.generateTotpCode,
  });

  let refreshToken = session.refreshToken;
  const first = await postJson(baseUrl, '/api/auth/refresh', {
    refresh_token: refreshToken,
  });
  assert.equal(first.response.status, 200);
  refreshToken = first.payload.refresh_token;

  const second = await postJson(baseUrl, '/api/auth/refresh', {
    refresh_token: refreshToken,
  });
  assert.equal(second.response.status, 200);
  refreshToken = second.payload.refresh_token;

  const third = await postJson(baseUrl, '/api/auth/refresh', {
    refresh_token: refreshToken,
  });
  assert.equal(third.response.status, 429);
  assert.equal(third.payload.code, 'too_many_refresh_requests');
});
