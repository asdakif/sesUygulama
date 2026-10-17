'use strict';

(() => {
  function create({ getSocket, getRoom, isUserMuted, applyOutputDevice }) {
    const $ = (id) => document.getElementById(id);
    const panel = $('soundboard-panel');
    const opener = $('soundboard-open');
    const list = $('soundboard-clips');
    const status = $('soundboard-status');
    const player = $('soundboard-audio');
    const volume = $('soundboard-volume');
    const enabled = $('soundboard-enabled');
    const stopButton = $('soundboard-stop');
    const retryButton = $('soundboard-retry');
    let catalog = [];
    let loading = null;
    let room = null;
    let pending = false;
    let cooldownUntil = 0;
    let cooldownTimer = null;
    let playbackTimer = null;
    let playbackVersion = 0;
    let playbackIsRemote = false;

    function save(key, value) {
      try { localStorage.setItem(`sesapp:soundboard:${key}`, String(value)); } catch {}
    }

    try {
      const saved = localStorage.getItem('sesapp:soundboard:volume');
      if (saved !== null && Number.isFinite(Number(saved))) volume.value = Math.max(0, Math.min(100, Number(saved)));
      enabled.checked = localStorage.getItem('sesapp:soundboard:enabled') !== 'false';
    } catch {}
    player.volume = Number(volume.value) / 100;
    $('soundboard-volume-value').textContent = `${volume.value}%`;

    function stop() {
      playbackVersion += 1;
      clearTimeout(playbackTimer);
      player.pause();
      player.removeAttribute('src');
      player.load();
      stopButton.disabled = true;
      opener.classList.remove('soundboard-playing');
      list.querySelectorAll('.soundboard-card').forEach((card) => card.classList.remove('is-playing'));
    }

    function sync() {
      const nextRoom = getRoom();
      if (room !== nextRoom || !getSocket()?.connected) {
        stop();
        pending = false;
        cooldownUntil = 0;
        clearTimeout(cooldownTimer);
        status.textContent = 'Önce kendin dinle, sonra odaya çal.';
      }
      room = nextRoom;
      const connected = Boolean(getSocket()?.connected);
      $('soundboard-room').textContent = !connected
        ? 'Bağlantı bekleniyor. Replikleri kendin dinleyebilirsin.'
        : room ? `Sesli kanal: ${room}` : 'Odaya çalmak için sesli kanala katıl.';
      const seconds = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      list.querySelectorAll('.soundboard-send').forEach((button) => {
        button.disabled = !room || !connected || pending || seconds > 0;
        button.textContent = seconds ? `${seconds} sn bekle` : pending ? 'Gönderiliyor…' : 'Odaya çal';
      });
      if (seconds) {
        clearTimeout(cooldownTimer);
        cooldownTimer = setTimeout(sync, 200);
      }
    }

    function setCooldown(ms) {
      cooldownUntil = Math.max(cooldownUntil, Date.now() + ms);
      sync();
    }

    function play(clip, username = null) {
      stop();
      const version = playbackVersion;
      playbackIsRemote = username !== null;
      player.src = clip.src;
      player.volume = Number(volume.value) / 100;
      stopButton.disabled = false;
      opener.classList.add('soundboard-playing');
      list.querySelectorAll('.soundboard-card').forEach((card) => {
        card.classList.toggle('is-playing', card.dataset.clipId === clip.id);
      });
      status.textContent = username ? `${username} çalıyor: ${clip.title}` : `Sadece sende: ${clip.title}`;
      // Start in the click gesture; changing the output device must not consume it.
      const playback = player.play();
      Promise.resolve(applyOutputDevice?.()).catch(() => {});
      playback.catch((error) => {
        if (version !== playbackVersion) return;
        stop();
        status.textContent = error.name === 'NotAllowedError'
          ? 'Ses için önce bir repliğin “Dinle” düğmesine bas.'
          : 'Ses açılamadı. Tekrar dene.';
      });
      playbackTimer = setTimeout(() => {
        if (version !== playbackVersion) return;
        stop();
        status.textContent = 'Replik tamamlandı.';
      }, Math.ceil(clip.duration * 1000) + 1500);
    }

    function send(clip) {
      const socket = getSocket();
      const sentRoom = getRoom();
      if (!socket?.connected || !sentRoom || pending || cooldownUntil > Date.now()) return;
      pending = true;
      sync();
      socket.timeout(4000).emit('soundboard_play', { clipId: clip.id }, (error, result) => {
        if (socket !== getSocket() || sentRoom !== getRoom()) return;
        pending = false;
        if (error || !result?.ok) {
          status.textContent = error ? 'Sunucu yanıt vermedi. Tekrar dene.' : result?.message || 'Replik çalınamadı.';
          if (result?.retryAfterMs) setCooldown(result.retryAfterMs);
        } else {
          setCooldown(result.cooldownMs);
          if (!enabled.checked) status.textContent = 'Odaya gönderildi. Replik sesi sende kapalı.';
        }
        sync();
      });
    }

    function render() {
      list.replaceChildren();
      for (const clip of catalog) {
        const card = document.createElement('div');
        card.className = 'soundboard-card';
        card.dataset.clipId = clip.id;
        const title = document.createElement('h3');
        title.textContent = clip.title;
        const detail = document.createElement('p');
        detail.textContent = `${clip.duration.toFixed(1).replace('.', ',')} sn${clip.explicit ? ' · Argo' : ''}`;
        const actions = document.createElement('div');
        actions.className = 'soundboard-card-actions';
        const preview = document.createElement('button');
        preview.type = 'button';
        preview.className = 'soundboard-preview';
        preview.textContent = '▷ Dinle';
        preview.setAttribute('aria-label', `${clip.title} — sadece kendin dinle`);
        preview.addEventListener('click', () => play(clip));
        const broadcast = document.createElement('button');
        broadcast.type = 'button';
        broadcast.className = 'soundboard-send';
        broadcast.setAttribute('aria-label', `${clip.title} — odaya çal`);
        broadcast.addEventListener('click', () => send(clip));
        actions.append(preview, broadcast);
        card.append(title, detail, actions);
        list.append(card);
      }
      sync();
    }

    function loadCatalog() {
      if (loading) return loading;
      retryButton.classList.add('hidden');
      loading = fetch('/replik-catalog.json')
        .then((response) => {
          if (!response.ok) throw new Error('catalog');
          return response.json();
        })
        .then((items) => { catalog = items; render(); })
        .catch(() => {
          list.textContent = 'Replikler yüklenemedi.';
          retryButton.classList.remove('hidden');
        })
        .finally(() => { loading = null; });
      return loading;
    }

    async function receive(payload) {
      if (!payload || payload.room !== getRoom() || !getSocket()?.connected) return;
      if (!catalog.length) await loadCatalog();
      if (payload.room !== getRoom() || !getSocket()?.connected) return;
      const clip = catalog.find((item) => item.id === payload.clipId);
      if (!clip) return;
      setCooldown(payload.cooldownMs);
      if (enabled.checked && !isUserMuted(payload.username)) play(clip, payload.username);
    }

    function close() {
      panel.classList.add('hidden');
      opener.setAttribute('aria-expanded', 'false');
      opener.focus();
    }
    opener.addEventListener('click', () => {
      const open = panel.classList.contains('hidden');
      panel.classList.toggle('hidden', !open);
      opener.setAttribute('aria-expanded', String(open));
      sync();
      if (open) $('soundboard-close').focus();
    });
    $('soundboard-close').addEventListener('click', close);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !panel.classList.contains('hidden')) {
        event.preventDefault();
        close();
      }
    });
    document.addEventListener('pointerdown', (event) => {
      if (!panel.classList.contains('hidden') && !panel.contains(event.target) && !opener.contains(event.target)) {
        panel.classList.add('hidden');
        opener.setAttribute('aria-expanded', 'false');
      }
    });
    volume.addEventListener('input', () => {
      player.volume = Number(volume.value) / 100;
      $('soundboard-volume-value').textContent = `${volume.value}%`;
      save('volume', volume.value);
    });
    enabled.addEventListener('change', () => {
      save('enabled', enabled.checked);
      if (!enabled.checked && playbackIsRemote) stop();
      status.textContent = enabled.checked ? 'Odadaki replikleri duyacaksın.' : 'Odadaki replikler sende sessiz.';
    });
    stopButton.addEventListener('click', () => {
      stop();
      status.textContent = 'Ses sende durduruldu.';
    });
    player.addEventListener('ended', () => {
      stop();
      status.textContent = 'Replik tamamlandı.';
    });
    retryButton.addEventListener('click', loadCatalog);
    loadCatalog();
    return { receive, sync, stop };
  }

  window.SesAppSoundboard = { create };
})();
