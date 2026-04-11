'use strict';

// Web Audio API ile ses efektleri — harici dosya gerektirmez
const ctx = new (window.AudioContext || window.webkitAudioContext)();

function resume() {
  if (ctx.state === 'suspended') ctx.resume();
}

function beep({ freq = 440, freq2, type = 'sine', vol = 0.3, duration = 0.15, delay = 0 } = {}) {
  resume();
  const t   = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (freq2) osc.frequency.linearRampToValueAtTime(freq2, t + duration);

  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(vol, t + 0.01);
  gain.gain.setValueAtTime(vol, t + duration - 0.03);
  gain.gain.linearRampToValueAtTime(0, t + duration);

  osc.start(t);
  osc.stop(t + duration);
}

const sounds = {
  // Sesli kanala katıldı — çıkıcı iki nota
  voiceJoin() {
    beep({ freq: 400, freq2: 600, duration: 0.12, vol: 0.25 });
    beep({ freq: 600, freq2: 800, duration: 0.12, vol: 0.25, delay: 0.1 });
  },

  // Sesli kanaldan ayrıldı — inen iki nota
  voiceLeave() {
    beep({ freq: 600, freq2: 400, duration: 0.12, vol: 0.2 });
    beep({ freq: 400, freq2: 250, duration: 0.12, vol: 0.2, delay: 0.1 });
  },

  // Mikrofon susturuldu — kısa kalın bip
  mute() {
    beep({ freq: 300, freq2: 200, type: 'sine', duration: 0.1, vol: 0.2 });
  },

  // Mikrofon açıldı — kısa tiz bip
  unmute() {
    beep({ freq: 500, freq2: 700, type: 'sine', duration: 0.1, vol: 0.2 });
  },

  // Biri kanala katıldı (metin kanalı)
  userJoin() {
    beep({ freq: 660, duration: 0.08, vol: 0.12 });
    beep({ freq: 880, duration: 0.08, vol: 0.12, delay: 0.07 });
  },

  // Yeni mesaj bildirimi
  message() {
    beep({ freq: 880, freq2: 1100, duration: 0.1, vol: 0.1 });
  },

  // DM bildirimi — biraz farklı
  dm() {
    beep({ freq: 700, duration: 0.07, vol: 0.15 });
    beep({ freq: 900, duration: 0.07, vol: 0.15, delay: 0.08 });
    beep({ freq: 1100, duration: 0.07, vol: 0.15, delay: 0.16 });
  },
};

window.sounds = sounds;
