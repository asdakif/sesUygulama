'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createAuditLogger } = require('../server/auth');

test('audit logger writes metadata through database sink', () => {
  const calls = [];
  const audit = createAuditLogger({
    db: {
      insertAuditLog(entry) {
        calls.push(entry);
      },
    },
  });

  audit.record('login_ok', {
    actorUsername: 'akif',
    ip: '127.0.0.1',
    userAgent: 'node-test',
    metadata: { source: 'unit' },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].event, 'login_ok');
  assert.equal(calls[0].actorUsername, 'akif');
  assert.equal(JSON.parse(calls[0].metadataJson).source, 'unit');
});
