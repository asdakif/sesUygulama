'use strict';

function createAuditLogger({ db }) {
  return {
    record(event, {
      actorUsername = null,
      targetUsername = null,
      ip = null,
      userAgent = null,
      metadata = null,
    } = {}) {
      db.insertAuditLog({
        ts: Date.now(),
        event,
        actorUsername,
        targetUsername: targetUsername ?? actorUsername,
        ip,
        userAgent,
        metadataJson: metadata ? JSON.stringify(metadata) : null,
      });
    },
  };
}

module.exports = {
  createAuditLogger,
};
