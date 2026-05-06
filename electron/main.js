const path = require('path');
const {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  session,
  shell,
} = require('electron');

const isMac = process.platform === 'darwin';
const DEFAULT_REMOTE_SERVER_URL = 'https://sesuygulama-production.up.railway.app';
const configuredRemoteServerUrl = (
  process.env.SESAPP_SERVER_URL?.trim() || DEFAULT_REMOTE_SERVER_URL
).replace(/\/+$/, '');

let mainWindow = null;
let localServerAddress = null;
let embeddedServer = null;
let quitting = false;
let currentPttKeyCode = 'Space';

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');

function isAllowedPermission(permission) {
  return ['media', 'display-capture', 'fullscreen'].includes(permission);
}

function getEmbeddedServer() {
  if (!embeddedServer) {
    process.env.SESAPP_DATA_FILE ||= path.join(app.getPath('userData'), 'chat-data.json');
    embeddedServer = require(path.join(__dirname, '..', 'server'));
  }
  return embeddedServer;
}

async function configureMediaPermissions() {
  const defaultSession = session.defaultSession;

  defaultSession.setPermissionCheckHandler((_webContents, permission) =>
    isAllowedPermission(permission)
  );

  defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(isAllowedPermission(permission));
  });

  if (typeof defaultSession.setDisplayMediaRequestHandler === 'function') {
    defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: true,
        });

        const fallbackSource = sources[0];
        if (!fallbackSource) {
          callback({});
          return;
        }

        callback({
          video: fallbackSource,
          audio: 'loopback',
        });
      } catch {
        callback({});
      }
    }, { useSystemPicker: true });
  }
}

async function ensureAppUrl() {
  if (localServerAddress) return `http://127.0.0.1:${localServerAddress.port}`;

  const address = await getEmbeddedServer().startServer({
    port: 0,
    host: '127.0.0.1',
    silent: true,
  });

  if (!address || typeof address === 'string') {
    throw new Error('Yerel sunucu adresi alınamadı.');
  }

  localServerAddress = address;
  return `http://127.0.0.1:${address.port}`;
}

async function loadApp(window) {
  if (configuredRemoteServerUrl) {
    try {
      await window.loadURL(configuredRemoteServerUrl);
      console.log(`✓ Railway sunucusuna bağlanıldı → ${configuredRemoteServerUrl}`);
      return;
    } catch (err) {
      console.warn(`Railway yüklenemedi, yerel sunucuya düşülüyor: ${err.message}`);
    }
  }

  const localAppUrl = await ensureAppUrl();
  await window.loadURL(localAppUrl);
  console.log(`✓ Yerel uygulama açıldı → ${localAppUrl}`);
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#1e1f22',
    autoHideMenuBar: true,
    show: false,
    title: 'SesApp',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false,
    },
  });

  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!currentPttKeyCode || input.code !== currentPttKeyCode) return;
    if (!['keyDown', 'keyUp'].includes(input.type)) return;
    mainWindow.webContents.send('ptt-key-event', {
      type: input.type,
      code: input.code,
      isAutoRepeat: input.isAutoRepeat,
    });
  });

  await loadApp(mainWindow);
}

async function bootstrap() {
  await app.whenReady();
  await configureMediaPermissions();
  await createMainWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
}

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

ipcMain.on('ptt:set-key', (_event, code) => {
  if (typeof code !== 'string' || !code.trim()) return;
  currentPttKeyCode = code.trim();
});

app.on('before-quit', (event) => {
  if (quitting || !embeddedServer?.server.listening) return;
  quitting = true;
  event.preventDefault();
  embeddedServer.stopServer()
    .catch((err) => console.error('Yerel sunucu kapatılamadı:', err))
    .finally(() => app.quit());
});

bootstrap().catch((err) => {
  console.error('Uygulama başlatılamadı:', err);
  app.quit();
});
