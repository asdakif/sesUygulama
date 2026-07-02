'use strict';

(function initSocketAuthRecovery(globalScope, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (globalScope) globalScope.SesAppSocketAuth = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function syncSocketAuthToken(socket, token) {
    if (!socket) return;
    socket.auth = {
      ...(socket.auth || {}),
      token: token || null,
    };
  }

  async function recoverInvalidSessionConnectError({
    err,
    tryRecoverSocketSession,
    recordRealtimeDebug = () => {},
    hideConnectionBanner = () => {},
  } = {}) {
    const code = err?.data?.code || null;
    if (code !== 'invalid_session' || typeof tryRecoverSocketSession !== 'function') return false;

    const recovered = await tryRecoverSocketSession();
    if (!recovered) return false;

    recordRealtimeDebug('socket_connect_error_recovered', { code });
    hideConnectionBanner();
    return true;
  }

  return {
    syncSocketAuthToken,
    recoverInvalidSessionConnectError,
  };
}));
