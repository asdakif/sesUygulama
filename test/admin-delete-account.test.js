'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { hashPassword } = require('../server/auth');
const {
  createIsolatedServer,
  postJson,
} = require('./helpers/integration-auth');

test('admin delete removes the account immediately and frees a reserved pending email', async (t) => {
  const harness = createIsolatedServer('sesapp-admin-delete-');
  const db = require('../database');

  t.after(async () => {
    await harness.stopServer().catch(() => {});
    harness.cleanup();
  });

  db.createAccount('admin', hashPassword('AdminPass123!mail'), { displayName: 'Admin' });
  db.setAccountEmail('admin', 'admin@example.com', Date.now());
  db.setAccountRole('admin', 'admin');

  db.createAccount('victim', hashPassword('VictimPass123!mail'), { displayName: 'Victim' });
  db.setAccountPendingEmail('victim', 'akos619@gmail.com', 'pending-token-hash', Date.now() + 60_000);

  const address = await harness.startServer({ port: 0, host: '127.0.0.1', silent: true });
  const port = typeof address === 'object' && address ? address.port : 3000;
  const baseUrl = `http://127.0.0.1:${port}`;

  harness.resetNoopOutbox();
  const login = await postJson(baseUrl, '/api/auth/login', {
    username: 'admin',
    password: 'AdminPass123!mail',
  });
  assert.equal(login.response.status, 200);
  assert.ok(login.payload.access_token);

  const deleteResponse = await fetch(`${baseUrl}/api/admin/users/${encodeURIComponent('victim')}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${login.payload.access_token}`,
    },
    body: JSON.stringify({ confirmation_phrase: 'HESABIMI SIL' }),
  });
  assert.equal(deleteResponse.status, 204);
  assert.equal(db.getAccount('victim'), null);

  harness.resetNoopOutbox();
  const register = await postJson(baseUrl, '/api/auth/register', {
    username: `fresh_${Date.now().toString(36)}`,
    email: 'akos619@gmail.com',
    password: 'FreshPass123!mail',
    inviteCode: process.env.REGISTRATION_INVITE,
  });
  assert.equal(register.response.status, 201);
  assert.ok(register.payload.access_token);
});
