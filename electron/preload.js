'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  setPttKey(code) {
    ipcRenderer.send('ptt:set-key', code);
  },
  onPttKeyEvent(callback) {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('ptt-key-event', handler);
    return () => ipcRenderer.removeListener('ptt-key-event', handler);
  },
});
