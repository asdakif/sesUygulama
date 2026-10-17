'use strict';

const catalog = require('../public/replik-catalog.json');

function createSoundboard({ io, connectedUsers, voiceRooms, now = Date.now }) {
  const clips = new Map(catalog.map((clip) => [clip.id, clip]));
  // Key by the room's member map so deleted rooms do not retain limiter state.
  const roomCooldowns = new WeakMap();
  const senderCooldowns = new WeakMap();

  function play(socket, payload) {
    const user = connectedUsers.get(socket.id);
    const clip = clips.get(payload?.clipId);
    if (!user || !clip) return { ok: false, message: 'Replik bulunamadı.' };

    // Never accept a destination or an audio URL supplied by a client.
    const room = [...voiceRooms].find(([, members]) => members.has(socket.id));
    if (!room) return { ok: false, message: 'Önce bir sesli kanala katıl.' };
    const [roomName, members] = room;
    const time = now();
    const availableAt = Math.max(roomCooldowns.get(members) || 0, senderCooldowns.get(socket) || 0);
    if (availableAt > time) {
      return { ok: false, message: 'Biraz bekle, ardından tekrar çal.', retryAfterMs: availableAt - time };
    }

    const cooldownMs = Math.max(3000, Math.ceil(clip.duration * 1000) + 350);
    roomCooldowns.set(members, time + cooldownMs);
    senderCooldowns.set(socket, time + cooldownMs);
    io.to(`voice:${roomName}`).emit('soundboard_play', {
      clipId: clip.id,
      room: roomName,
      username: user.username,
      cooldownMs,
    });
    return { ok: true, cooldownMs };
  }

  return { play };
}

module.exports = { createSoundboard };
