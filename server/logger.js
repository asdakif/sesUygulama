'use strict';

function normalizeMeta(meta = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value instanceof Error) {
      normalized[key] = {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

function write(level, scope, event, meta) {
  const payload = {
    time: new Date().toISOString(),
    level,
    scope,
    event,
    ...normalizeMeta(meta),
  };
  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function createLogger(scope) {
  return {
    debug(event, meta) { write('debug', scope, event, meta); },
    info(event, meta) { write('info', scope, event, meta); },
    warn(event, meta) { write('warn', scope, event, meta); },
    error(event, meta) { write('error', scope, event, meta); },
    child(childScope) {
      return createLogger(`${scope}:${childScope}`);
    },
  };
}

module.exports = {
  createLogger,
};
