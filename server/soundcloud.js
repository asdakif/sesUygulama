'use strict';

function createSoundCloudService({
  fetchImpl,
  logger,
  refreshMs,
  userAgent,
}) {
  let scClientId = null;
  let refreshTimer = null;

  async function refreshClientId() {
    try {
      const response = await fetchImpl('https://soundcloud.com', {
        headers: { 'User-Agent': userAgent },
      });
      const html = await response.text();
      const match = html.match(/window\.__sc_hydration\s*=\s*(\[[\s\S]*?\]);\s*<\/script>/);
      if (!match) {
        logger.warn('client_id_missing');
        return null;
      }
      const hydration = JSON.parse(match[1]);
      const apiClient = hydration.find((entry) => entry.hydratable === 'apiClient');
      if (apiClient?.data?.id) {
        scClientId = apiClient.data.id;
        logger.info('client_id_refreshed');
      }
      return scClientId;
    } catch (error) {
      logger.error('client_id_refresh_failed', { error });
      return null;
    }
  }

  async function searchTracks(query) {
    const trimmed = (query || '').trim().slice(0, 200);
    if (!trimmed) return { results: [] };
    if (!scClientId) return { results: [], error: 'SC henüz hazır değil' };

    try {
      const response = await fetchImpl(
        `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(trimmed)}&limit=5&client_id=${scClientId}`,
        { headers: { 'User-Agent': userAgent } },
      );
      const data = await response.json();
      const results = (data.collection || []).slice(0, 5).map((track) => ({
        trackUrl: track.permalink_url,
        title: track.title,
        thumbnail: (track.artwork_url || track.user?.avatar_url || '').replace('-large', '-t300x300'),
        artist: track.user?.username || '',
      }));
      return { results };
    } catch (error) {
      logger.error('search_failed', { error, query: trimmed });
      return { results: [] };
    }
  }

  function start() {
    if (refreshTimer) return;
    refreshClientId();
    refreshTimer = setInterval(refreshClientId, refreshMs);
    refreshTimer.unref?.();
  }

  function stop() {
    if (!refreshTimer) return;
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  function getClientId() {
    return scClientId;
  }

  return {
    getClientId,
    refreshClientId,
    searchTracks,
    start,
    stop,
  };
}

module.exports = {
  createSoundCloudService,
};
