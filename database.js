/**
 * JSON tabanlı veritabanı
 */

const fs   = require('fs');
const path = require('path');

const DATA_FILE = process.env.SESAPP_DATA_FILE || path.join(__dirname, 'chat-data.json');

const defaultData = {
  channels: [
    { id: 1, name: 'genel',     description: 'Genel sohbet kanalı' },
    { id: 2, name: 'oyun',      description: 'Oyun konuşmaları' },
    { id: 3, name: 'müzik',     description: 'Müzik önerileri' },
    { id: 4, name: 'duyurular', description: 'Önemli duyurular' },
  ],
  messages:      [], // { id, channel_id, username, content, created_at, reactions:{} }
  dms:           [], // { id, from, to, content, created_at }
  users:         [],
  nextMessageId: 1,
  nextDmId:      1,
};

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch { /* hatalı dosyayı görmezden gel */ }
  save(defaultData);
  return JSON.parse(JSON.stringify(defaultData));
}

function save(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

let data = load();

module.exports = {
  getChannels() { return data.channels; },

  getChannelById(id) {
    return data.channels.find(c => c.id === id) || null;
  },

  getMessages(channelId, limit = 60) {
    return data.messages
      .filter(m => m.channel_id === channelId)
      .map(m => ({ ...m, reactions: m.reactions || {} }))
      .slice(-limit);
  },

  insertMessage(channelId, username, content) {
    const msg = {
      id:         data.nextMessageId++,
      channel_id: channelId,
      username,
      content,
      created_at: Math.floor(Date.now() / 1000),
      reactions:  {},
    };
    data.messages.push(msg);
    if (data.messages.length > 5000) data.messages = data.messages.slice(-4000);
    save(data);
    return msg;
  },

  toggleReaction(messageId, username, emoji) {
    const msg = data.messages.find(m => m.id === messageId);
    if (!msg) return null;
    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];

    const idx = msg.reactions[emoji].indexOf(username);
    if (idx === -1) {
      msg.reactions[emoji].push(username);
    } else {
      msg.reactions[emoji].splice(idx, 1);
      if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    }
    save(data);
    return { ...msg };
  },

  // DM — iki kullanıcı arasındaki konuşma anahtarı: "a:b" (alfabetik sıra)
  getDmKey(userA, userB) {
    return [userA, userB].sort().join(':');
  },

  getDms(userA, userB, limit = 60) {
    const key = this.getDmKey(userA, userB);
    return data.dms
      .filter(m => this.getDmKey(m.from, m.to) === key)
      .slice(-limit);
  },

  insertDm(from, to, content) {
    const msg = {
      id:         data.nextDmId++,
      from,
      to,
      content,
      created_at: Math.floor(Date.now() / 1000),
    };
    data.dms.push(msg);
    if (data.dms.length > 10000) data.dms = data.dms.slice(-8000);
    save(data);
    return msg;
  },

  ensureUser(username) {
    if (!data.users.includes(username)) {
      data.users.push(username);
      save(data);
    }
  },
};
