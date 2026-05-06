'use strict';

function createMusicState() {
  return { current: null, queue: [], isPlaying: false, startedAt: 0, elapsed: 0 };
}

function createRealtimeState({ io, defaultVoiceRooms }) {
  const connectedUsers = new Map(); // socketId -> { username, channelId, sessionId }
  const voiceRooms = new Map(defaultVoiceRooms.map((roomName) => [roomName, new Map()]));
  const screenShares = new Map(); // channelId -> { sharerId, username }
  const musicState = new Map(); // voiceRoom -> music state

  function getRoomName(channelId) {
    return `channel:${channelId}`;
  }

  function getUsersInChannel(channelId) {
    const seen = new Set();
    for (const [, user] of connectedUsers) {
      if (user.channelId === channelId) seen.add(user.username);
    }
    return [...seen];
  }

  function broadcastUserList(channelId) {
    io.to(getRoomName(channelId)).emit('user_list', {
      users: getUsersInChannel(channelId),
    });
  }

  function getAllOnlineUsers() {
    const seen = new Set();
    for (const [, user] of connectedUsers) seen.add(user.username);
    return [...seen];
  }

  function isUsernameTaken(username) {
    for (const [, user] of connectedUsers) {
      if (user.username.toLowerCase() === username.toLowerCase()) return true;
    }
    return false;
  }

  function getSocketIdByUsername(username) {
    for (const [socketId, user] of connectedUsers) {
      if (user.username.toLowerCase() === username.toLowerCase()) return socketId;
    }
    return null;
  }

  function broadcastVoiceChannelList() {
    io.emit('voice_channels_list', [...voiceRooms.keys()]);
  }

  function broadcastVoiceRooms() {
    const state = {};
    for (const [roomName, members] of voiceRooms) {
      state[roomName] = [...members.values()].map((member) => member.username);
    }
    io.emit('voice_rooms_state', state);
  }

  function leaveAllVoiceRooms(socket) {
    for (const [roomName, members] of voiceRooms) {
      if (!members.has(socket.id)) continue;
      members.delete(socket.id);
      socket.to(`voice:${roomName}`).emit('voice_peer_left', { socketId: socket.id });
      socket.leave(`voice:${roomName}`);
    }
    broadcastVoiceRooms();
  }

  function getActiveScreenShare(channelId) {
    const share = screenShares.get(channelId);
    if (!share) return null;
    if (!io.sockets.sockets.get(share.sharerId)) {
      screenShares.delete(channelId);
      return null;
    }
    return share;
  }

  function emitActiveScreenShareToSocket(socket, channelId) {
    const share = getActiveScreenShare(channelId);
    if (!share || share.sharerId === socket.id) return;
    socket.emit('screen_share_available', share);
  }

  function findScreenShareChannelBySharer(sharerId) {
    for (const [channelId, share] of screenShares) {
      if (share.sharerId === sharerId) return channelId;
    }
    return null;
  }

  function endScreenShare(sharerId, channelId = findScreenShareChannelBySharer(sharerId)) {
    if (channelId == null) return false;
    const share = screenShares.get(channelId);
    if (!share || share.sharerId !== sharerId) return false;
    screenShares.delete(channelId);
    io.to(getRoomName(channelId)).emit('screen_share_ended', { sharerId });
    return true;
  }

  function getMusicPayload(voiceRoom) {
    const state = musicState.get(voiceRoom) || createMusicState();
    const elapsed = state.isPlaying
      ? (Date.now() - state.startedAt) / 1000
      : state.elapsed;
    return {
      current: state.current,
      queue: state.queue,
      isPlaying: state.isPlaying,
      elapsed,
      serverTime: Date.now(),
    };
  }

  function advanceMusicQueue(voiceRoom) {
    const state = musicState.get(voiceRoom) || createMusicState();
    if (state.queue.length === 0) {
      state.current = null;
      state.isPlaying = false;
      state.elapsed = 0;
    } else {
      state.current = state.queue.shift();
      state.isPlaying = true;
      state.startedAt = Date.now();
      state.elapsed = 0;
    }
    musicState.set(voiceRoom, state);
    io.to(`voice:${voiceRoom}`).emit('music_state', getMusicPayload(voiceRoom));
  }

  return {
    connectedUsers,
    voiceRooms,
    screenShares,
    musicState,
    createMusicState,
    getRoomName,
    broadcastUserList,
    getAllOnlineUsers,
    isUsernameTaken,
    getSocketIdByUsername,
    broadcastVoiceChannelList,
    broadcastVoiceRooms,
    leaveAllVoiceRooms,
    getActiveScreenShare,
    emitActiveScreenShareToSocket,
    findScreenShareChannelBySharer,
    endScreenShare,
    getMusicPayload,
    advanceMusicQueue,
  };
}

module.exports = {
  createRealtimeState,
};
