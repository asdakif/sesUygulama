'use strict';

function bootstrapAdminRole({
  db,
  config,
  audit,
  logger,
}) {
  const configuredUsername = config.bootstrapAdminUsername;
  if (configuredUsername) {
    const account = db.getAccount(configuredUsername);
    if (account && account.role !== 'admin') {
      db.setAccountRole(account.username, 'admin');
      audit.record('bootstrap_admin_set', {
        actorUsername: account.username,
        targetUsername: account.username,
        metadata: { rule: 'env' },
      });
      logger.info('bootstrap_admin_set', { username: account.username, rule: 'env' });
    }
    return;
  }

  if (db.countAdminAccounts() > 0 || db.countAccounts() === 0) return;
  const firstAccount = db.getFirstAccount();
  if (!firstAccount || firstAccount.role === 'admin') return;
  db.setAccountRole(firstAccount.username, 'admin');
  audit.record('bootstrap_admin_first_user', {
    actorUsername: firstAccount.username,
    targetUsername: firstAccount.username,
    metadata: { rule: 'first_user' },
  });
  logger.info('bootstrap_admin_first_user', { username: firstAccount.username });
}

module.exports = {
  bootstrapAdminRole,
};
