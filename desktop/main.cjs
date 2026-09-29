const { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { autoUpdater } = require('electron-updater');
const update = require('./update.cjs');

// 固定 origin，避免便携版换目录或升级后 localStorage 被视为另一份数据。
protocol.registerSchemesAsPrivileged([{
  scheme: 'nexus',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}]);

// 固定目录保证新版 EXE 放到任何位置时都继续使用同一份本机数据。
app.setPath('userData', path.join(app.getPath('appData'), 'NEXUS-Workbench'));
const configPath = path.join(app.getPath('userData'), 'update.json');
const entryUrl = 'nexus://app/nexus-workbench.html';
const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
const publicFeedUrl = 'https://github.com/Yujay-Si/workbench/releases/latest/download/latest.json';
const publicReleasePage = 'https://github.com/Yujay-Si/workbench/releases/latest';
let updaterState = { status: 'idle' };

function publishUpdaterState(next) {
  updaterState = next;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('nexus:update-state', next);
  }
}

function configureInstalledUpdater() {
  if (isPortable || !app.isPackaged) return;
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
  const button = retry ? '<button id="retry">重试</button><script>document.getElementById("retry").onclick=function(){window.nexusDesktop.retryLoad()}</script>' : '';
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>NEXUS · 工作台</title>
    <style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#04070c;color:#dceefb;font:16px system-ui}
    main{max-width:560px;padding:32px}h1{font-size:24px}p{line-height:1.7;color:#8aa8c0}
    button{padding:10px 18px;border:1px solid #38c6f4;border-radius:8px;background:#102436;color:#dceefb;cursor:pointer}</style>
    <main><h1>${escape(message)}</h1><p>${escape(detail)}</p>${button}</main></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function writeStartupError(message) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'startup.log'),
      new Date().toISOString() + ' ' + message + '\n', 'utf8');
  } catch { /* 日志失败不阻断错误页面。 */ }
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
          `已自动重试。请点击重试；如果仍失败，请提供数据目录中的 startup.log。错误：${reason}`, true))
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
    title: 'NEXUS · 工作台',
    backgroundColor: '#04070C',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
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
  mode: isPortable ? 'portable' : (app.isPackaged ? 'installed' : 'development'),
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
  if (isPortable || updaterState.status !== 'downloaded') throw new Error('尚无可安装的新版本');
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return true;
});

ipcMain.handle('nexus:update-choose-local', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择新版 NEXUS EXE',
    properties: ['openFile'],
    filters: [{ name: 'NEXUS 可执行文件', extensions: ['exe'] }]
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

app.whenReady().then(() => {
  const allowed = {
    '/nexus-workbench.html': path.join(__dirname, '..', 'nexus-workbench.html'),
    '/desktop/ui.js': path.join(__dirname, 'ui.js')
  };
  protocol.handle('nexus', (request) => {
    const url = new URL(request.url);
    const file = url.hostname === 'app' ? allowed[url.pathname] : null;
    return file ? net.fetch(pathToFileURL(file).href) : new Response('Not found', { status: 404 });
  });
  createWindow();
  configureInstalledUpdater();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
