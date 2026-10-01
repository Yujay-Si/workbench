const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, protocol, shell, Tray } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { autoUpdater } = require('electron-updater');
const update = require('./update.cjs');
const localApps = require('./local-apps.cjs');
const { createAccountClient, LOCAL_SERVER } = require('./account-client.cjs');
const { createServer } = require('../server/index.cjs');
const i18n = require('../i18n/messages.js');

// 固定 origin，避免便携版换目录或升级后 localStorage 被视为另一份数据。
protocol.registerSchemesAsPrivileged([{
  scheme: 'nexus',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}]);

// 固定目录保证新版 EXE 放到任何位置时都继续使用同一份本机数据。
app.setPath('userData', path.join(app.getPath('appData'), 'NEXUS-Workbench'));
const configPath = path.join(app.getPath('userData'), 'update.json');
const languagePath = path.join(app.getPath('userData'), 'language.json');
function readLanguage() {
  try { return i18n.normalize(JSON.parse(fs.readFileSync(languagePath, 'utf8')).language); }
  catch { return 'zh-CN'; }
}
let currentLanguage = readLanguage();
const tr = (source) => i18n.t(source, currentLanguage);
const accountClient = createAccountClient(path.join(app.getPath('userData'), 'server.json'));
let localAccountService = null;
const entryUrl = 'nexus://app/nexus-workbench.html';
const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
const publicFeedUrl = 'https://github.com/Yujay-Si/workbench/releases/latest/download/latest.json';
const publicReleasePage = 'https://github.com/Yujay-Si/workbench/releases/latest';
let updaterState = { status: 'idle' };
let mainWindow = null;
let tray = null;
let isQuitting = false;
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function quitApplication() {
  isQuitting = true;
  app.quit();
}

function ensureTray() {
  if (!tray) {
    const icon = process.platform === 'darwin'
      ? nativeImage.createFromPath(path.join(__dirname, 'assets', 'workbench.png')).resize({ width: 18, height: 18 })
      : path.join(__dirname, 'assets', 'workbench.ico');
    tray = new Tray(icon);
    tray.on('double-click', showMainWindow);
  }
  tray.setToolTip(tr('NEXUS 工作台'));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: tr('打开 NEXUS'), click: showMainWindow },
    { type: 'separator' },
    { label: tr('退出 NEXUS'), click: quitApplication }
  ]));
}

if (hasSingleInstanceLock) app.on('second-instance', showMainWindow);

function publishUpdaterState(next) {
  updaterState = next;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('nexus:update-state', next);
  }
}

function configureInstalledUpdater() {
  // Unsigned macOS builds use the Release page for manual DMG replacement.
  if (process.platform === 'darwin' || isPortable || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  // 安装由用户在界面上确认，避免关机时触发后台安装。
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('checking-for-update', () => publishUpdaterState({ status: 'checking' }));
  autoUpdater.on('update-available', (info) =>
    publishUpdaterState({ status: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () =>
    publishUpdaterState({ status: 'latest', version: app.getVersion() }));
  autoUpdater.on('download-progress', (progress) =>
    publishUpdaterState({ status: 'downloading', percent: Math.round(progress.percent) }));
  autoUpdater.on('update-downloaded', (info) =>
    publishUpdaterState({ status: 'downloaded', version: info.version }));
  autoUpdater.on('error', (error) =>
    publishUpdaterState({ status: 'error', message: error.message }));
  setTimeout(() => {
    if (BrowserWindow.getAllWindows().length) autoUpdater.checkForUpdates().catch((error) =>
      publishUpdaterState({ status: 'error', message: error.message }));
  }, 5000);
}

function externalUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function startupPage(message, detail = '', retry = false) {
  // 使用 data 页面显示状态，应用协议加载失败时也能看到说明。
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  const button = retry ? `<button id="retry">${escape(tr('重试'))}</button><script>document.getElementById("retry").onclick=function(){window.nexusDesktop.retryLoad()}</script>` : '';
  const html = `<!doctype html><html lang="${currentLanguage}"><meta charset="utf-8"><title>${escape(tr('NEXUS · 工作台'))}</title>
    <style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#04070c;color:#dceefb;font:16px system-ui}
    main{max-width:560px;padding:32px}h1{font-size:24px}p{line-height:1.7;color:#8aa8c0}
    button{padding:10px 18px;border:1px solid #38c6f4;border-radius:8px;background:#102436;color:#dceefb;cursor:pointer}</style>
    <main><h1>${escape(tr(message))}</h1><p>${escape(tr(detail))}</p>${button}</main></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function writeStartupError(message) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'startup.log'),
      new Date().toISOString() + ' ' + message + '\n', 'utf8');
  } catch { /* 日志失败不阻断错误页面。 */ }
}

async function ensureLocalAccountService() {
  if (accountClient.getServerUrl().url !== LOCAL_SERVER) return;
  try {
    const response = await fetch(LOCAL_SERVER + '/api/session', { signal: AbortSignal.timeout(1000) });
    if (response.ok && Object.hasOwn(await response.json(), 'account')) return;
  } catch { /* 本机预览服务未启动，改用 EXE 内置的账号服务。 */ }

  const service = createServer({ databaseFile: path.join(app.getPath('userData'), 'accounts.sqlite') });
  function listen(port) {
    return new Promise((resolve, reject) => {
      service.server.once('error', reject);
      service.server.listen(port, '127.0.0.1', () => {
        service.server.removeListener('error', reject);
        resolve();
      });
    });
  }
  try {
    await listen(8768);
  } catch (error) {
    if (error.code !== 'EADDRINUSE') { service.store.db.close(); throw error; }
    // 端口被其他程序占用时仍让桌面版使用自己的本机数据库。
    await listen(0);
    accountClient.useLocalUrl(`http://127.0.0.1:${service.server.address().port}`);
  }
  localAccountService = service;
}

function loadWorkbench(win) {
  let attemptNumber = 0;
  function attempt() {
    if (win.isDestroyed()) return;
    const id = ++attemptNumber;
    let settled = false;
    let timer;
    function fail(reason) {
      if (settled || id !== attemptNumber || win.isDestroyed()) return;
      settled = true;
      clearTimeout(timer);
      writeStartupError(`第 ${id} 次加载失败：${reason}`);
      if (id < 2) {
        win.webContents.stop();
        setTimeout(attempt, 400);
      } else {
        win.loadURL(startupPage('工作台加载失败',
          i18n.t('已自动重试。请点击重试；如果仍失败，请提供数据目录中的 startup.log。错误：{error}', currentLanguage, { error: reason }), true))
          .catch((error) => writeStartupError('错误页面显示失败：' + error.message));
      }
    }
    timer = setTimeout(() => fail('页面加载超过 10 秒'), 10000);
    win.loadURL(entryUrl).then(() => {
      if (id !== attemptNumber || settled) return;
      settled = true;
      clearTimeout(timer);
    }).catch((error) => fail(error.message));
  }
  attempt();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 900,
    minHeight: 620,
    title: tr('NEXUS · 工作台'),
    icon: path.join(__dirname, 'assets', process.platform === 'darwin' ? 'workbench.png' : 'workbench.ico'),
    backgroundColor: '#04070C',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow = win;
  win.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      title: tr('关闭 NEXUS'),
      message: tr('请选择关闭方式'),
      detail: tr('仅关闭窗口后，NEXUS 会继续在后台运行。可从系统托盘或再次点击快捷方式打开。'),
      buttons: [tr('仅关闭窗口，后台运行'), tr('关闭此软件')],
      defaultId: 0,
      noLink: true
    });
    if (choice === 0) {
      ensureTray();
      win.hide();
    } else if (choice === 1) {
      quitApplication();
    }
  });
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  win.loadURL(startupPage('NEXUS 正在启动', '正在加载工作台，请稍候…'))
    .then(() => loadWorkbench(win))
    .catch((error) => {
      writeStartupError('启动页加载失败：' + error.message);
      loadWorkbench(win);
    });
  win.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalUrl(url);
    if (external) shell.openExternal(external).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== entryUrl) {
      event.preventDefault();
      const external = externalUrl(url);
      if (external) shell.openExternal(external).catch(() => {});
    }
  });
}

ipcMain.handle('nexus:update-info', () => ({
  version: app.getVersion(),
  mode: process.platform === 'darwin' && app.isPackaged ? 'mac' :
    (isPortable ? 'portable' : (app.isPackaged ? 'installed' : 'development')),
  feedUrl: update.readFeed(configPath) || publicFeedUrl,
  releasePage: publicReleasePage,
  updateState: updaterState,
  dataDir: app.getPath('userData')
}));

ipcMain.handle('nexus:update-save-feed', (_event, url) => {
  const saved = update.saveFeed(configPath, url);
  return { feedUrl: saved || publicFeedUrl, defaulted: !saved };
});

ipcMain.handle('nexus:update-check', async () => {
  if (process.platform === 'darwin') return { status: 'manual', releasePage: publicReleasePage };
  if (!isPortable) {
    if (!app.isPackaged) return { status: 'development' };
    if (['checking', 'downloading', 'downloaded'].includes(updaterState.status)) return updaterState;
    autoUpdater.checkForUpdates().catch((error) =>
      publishUpdaterState({ status: 'error', message: error.message }));
    return { status: 'checking' };
  }
  return update.checkFeed(update.readFeed(configPath) || publicFeedUrl, app.getVersion());
});

ipcMain.handle('nexus:update-install', () => {
  if (process.platform === 'darwin') throw new Error('macOS 版请从发布页手动安装 DMG');
  if (isPortable || updaterState.status !== 'downloaded') throw new Error('尚无可安装的新版本');
  setImmediate(() => {
    isQuitting = true;
    autoUpdater.quitAndInstall(false, true);
  });
  return true;
});

ipcMain.handle('nexus:update-choose-local', async () => {
  const result = await dialog.showOpenDialog({
    title: tr('选择新版 NEXUS EXE'),
    properties: ['openFile'],
    filters: [{ name: tr('NEXUS 可执行文件'), extensions: ['exe'] }]
  });
  if (result.canceled || !result.filePaths.length) return { status: 'cancelled' };
  const chosen = result.filePaths[0];
  const version = update.versionFromFilename(chosen);
  if (!version || !update.isNewer(version, app.getVersion())) {
    throw new Error('请选择版本号更高的 NEXUS-Workbench-版本号-win-x64.exe');
  }
  if (!fs.statSync(chosen).isFile()) throw new Error('选择的文件不是 EXE 文件');
  shell.showItemInFolder(chosen);
  return { status: 'selected', version };
});

ipcMain.handle('nexus:open-protocol', async (_event, url) => {
  // 页面存储可由备份导入；只允许已知的本机应用协议，防止任意协议被调用。
  if (!['weixin://', 'tencent://', 'wps://'].includes(url)) {
    throw new Error('桌面版暂不支持此本机启动协议');
  }
  await shell.openExternal(url);
  return true;
});

ipcMain.handle('nexus:open-local-app', async (_event, appId) => {
  if (process.platform !== 'win32') return { status: 'unsupported' };
  const executable = localApps.findInstalledApp(appId);
  if (!executable) return { status: 'missing' };
  const error = await shell.openPath(executable);
  if (error) throw new Error('启动本机应用失败：' + error);
  return { status: 'opened' };
});

ipcMain.handle('nexus:open-external', async (_event, url) => {
  const external = externalUrl(url);
  if (!external) throw new Error('网页地址无效');
  await shell.openExternal(external);
  return true;
});

ipcMain.handle('nexus:retry-load', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) loadWorkbench(win);
  return Boolean(win);
});

function trustedAccountFrame(event) {
  if (!event.senderFrame || event.senderFrame.url !== entryUrl) throw new Error('账号操作来源无效');
}

ipcMain.handle('nexus:account-server-info', (event) => { trustedAccountFrame(event); return accountClient.getServerUrl(); });
ipcMain.handle('nexus:account-server-save', async (event, url) => {
  trustedAccountFrame(event);
  const result = accountClient.setServerUrl(url);
  if (result.url === LOCAL_SERVER) await ensureLocalAccountService();
  return result;
});
ipcMain.handle('nexus:account-register', (event, username, password) => {
  trustedAccountFrame(event); return accountClient.register(username, password);
});
ipcMain.handle('nexus:account-login', (event, username, password) => {
  trustedAccountFrame(event); return accountClient.login(username, password);
});
ipcMain.handle('nexus:account-logout', (event) => { trustedAccountFrame(event); return accountClient.logout(); });
ipcMain.handle('nexus:account-session', (event) => { trustedAccountFrame(event); return accountClient.session(); });
ipcMain.handle('nexus:account-workspace', (event) => { trustedAccountFrame(event); return accountClient.getWorkspace(); });
ipcMain.handle('nexus:account-backup-status', (event) => { trustedAccountFrame(event); return accountClient.backupStatus(); });
ipcMain.handle('nexus:account-save', (event, revision, data) => {
  trustedAccountFrame(event); return accountClient.saveWorkspace(revision, data);
});

ipcMain.handle('nexus:language-get', (event) => { trustedAccountFrame(event); return currentLanguage; });
ipcMain.handle('nexus:language-set', (event, language) => {
  trustedAccountFrame(event);
  if (language !== 'zh-CN' && language !== 'en-US') throw new Error('Invalid language');
  currentLanguage = language;
  fs.mkdirSync(path.dirname(languagePath), { recursive: true });
  fs.writeFileSync(languagePath, JSON.stringify({ language }), 'utf8');
  if (tray) ensureTray();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(tr('NEXUS · 工作台'));
  return currentLanguage;
});

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  const allowed = {
    '/nexus-workbench.html': path.join(__dirname, '..', 'nexus-workbench.html'),
    '/desktop/ui.js': path.join(__dirname, 'ui.js'),
    '/i18n/messages.js': path.join(__dirname, '..', 'i18n', 'messages.js')
    ,'/auth/client.js': path.join(__dirname, '..', 'auth', 'client.js')
    ,'/auth/sync.js': path.join(__dirname, '..', 'auth', 'sync.js')
  };
  protocol.handle('nexus', (request) => {
    const url = new URL(request.url);
    const file = url.hostname === 'app' ? allowed[url.pathname] : null;
    return file ? net.fetch(pathToFileURL(file).href) : new Response('Not found', { status: 404 });
  });
  try { await ensureLocalAccountService(); }
  catch (error) { writeStartupError('本机账号服务启动失败：' + error.message); }
  createWindow();
  configureInstalledUpdater();
  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) showMainWindow();
    else createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  isQuitting = true;
  if (localAccountService) {
    localAccountService.server.close();
    localAccountService.store.db.close();
    localAccountService = null;
  }
});
