(function () {
  'use strict';
  if (!window.nexusDesktop) return;

  var api = window.nexusDesktop;
  var root = document.getElementById('desktopUpdate');
  var details = document.getElementById('updateDetails');
  var status = document.getElementById('updateStatus');
  var feed = document.getElementById('updateFeed');
  var download = document.getElementById('btnDownloadUpdate');
  var downloadUrl = '';
  var mode = 'portable';
  var currentVersion = '';
  var tr = function (source, params) { return window.nexusI18n.t(source, document.documentElement.lang, params); };
  var lastStatus = null;
  function statusText(source, params) {
    lastStatus = { source: source, params: params };
    status.textContent = tr(source, params);
  }
  document.addEventListener('nexus-language-change', function () {
    if (lastStatus) status.textContent = tr(lastStatus.source, lastStatus.params);
    if (currentVersion) document.getElementById('updateVersion').textContent = tr('当前版本：v{version}', { version: currentVersion });
    if (mode === 'installed' || mode === 'mac') {
      feed.previousElementSibling.textContent = tr('发布地址（GitHub Releases）');
      download.textContent = tr(mode === 'mac' ? '打开发布页' : '重启并安装');
    }
  });

  function showStatus(message) { statusText(message); }
  function errorMessage(error) { return tr(error && error.message ? error.message : String(error)); }
  function busy(value) {
    document.getElementById('btnCheckUpdate').disabled = value;
    document.getElementById('btnSaveFeed').disabled = value;
    document.getElementById('btnLocalUpdate').disabled = value;
  }

  function renderInstalledState(next) {
    if (!next) return;
    download.classList.add('hidden');
    if (next.status === 'checking') statusText('正在检查 GitHub Releases…');
    else if (next.status === 'available') statusText('发现新版 v{version}，正在下载…', next);
    else if (next.status === 'downloading') statusText('正在下载新版：{percent}%', next);
    else if (next.status === 'downloaded') {
      statusText('新版 v{version} 已下载。点击「重启并安装」完成更新，本机数据会保留。', next);
      download.classList.remove('hidden');
    } else if (next.status === 'latest') statusText('已是最新版本：v{version}。', next);
    else if (next.status === 'error') statusText('检查或下载失败：{message}', next);
  }

  root.classList.remove('hidden');
  document.getElementById('btnUpdatePanel').addEventListener('click', function () {
    details.classList.toggle('hidden');
  });
  api.info().then(function (info) {
    mode = info.mode;
    currentVersion = info.version;
    document.getElementById('updateVersion').textContent = tr('当前版本：v{version}', info);
    feed.value = info.feedUrl || '';
    if (mode === 'installed' || mode === 'mac') {
      feed.value = info.releasePage;
      feed.readOnly = true;
      feed.previousElementSibling.textContent = tr('发布地址（GitHub Releases）');
      document.getElementById('btnSaveFeed').classList.add('hidden');
      document.getElementById('btnLocalUpdate').classList.add('hidden');
      if (mode === 'mac') {
        document.getElementById('btnCheckUpdate').classList.add('hidden');
        downloadUrl = info.releasePage;
        download.textContent = tr('打开发布页');
        download.classList.remove('hidden');
        showStatus('macOS 版请从发布页下载新版 DMG 并手动安装。');
      } else {
        download.textContent = '重启并安装';
        showStatus('程序启动后会检查发布地址中的新版；也可点击「检查更新」。');
        renderInstalledState(info.updateState);
        api.onUpdateState(renderInstalledState);
      }
    } else if (mode === 'development') {
      document.getElementById('btnCheckUpdate').classList.add('hidden');
      showStatus('开发预览模式；发布后可从 GitHub Releases 检查更新。');
    } else {
      showStatus('更新源已预设为 GitHub Releases。检查到新版后可下载并双击运行；本机数据会保留。');
    }
  }).catch(function (error) { statusText('读取版本信息失败：{message}', { message: errorMessage(error) }); });

  document.getElementById('btnSaveFeed').addEventListener('click', function () {
    busy(true);
    api.saveFeed(feed.value).then(function (result) {
      feed.value = result.feedUrl;
      showStatus(result.defaulted ? '已恢复默认 GitHub Releases 更新地址。' : '更新地址已保存。');
      download.classList.add('hidden');
      downloadUrl = '';
    }).catch(function (error) { statusText('保存失败：{message}', { message: errorMessage(error) }); })
      .finally(function () { busy(false); });
  });

  document.getElementById('btnCheckUpdate').addEventListener('click', function () {
    busy(true);
    showStatus('正在检查新版本…');
    api.check().then(function (result) {
      if (mode === 'installed') { renderInstalledState(result); return; }
      download.classList.add('hidden');
      downloadUrl = '';
      if (result.status === 'unconfigured') {
        showStatus('尚未设置更新地址。可填写发布方提供的 HTTPS 清单地址，或选择本地新版 EXE。');
      } else if (result.status === 'available') {
        downloadUrl = result.downloadUrl;
        download.classList.remove('hidden');
        statusText('发现新版 v{version}。下载后双击打开新版 EXE，原有本机数据会保留。', result);
      } else {
        statusText('已是最新版本：v{version}。', { version: result.currentVersion });
      }
    }).catch(function (error) { statusText('检查失败：{message}', { message: errorMessage(error) }); })
      .finally(function () { busy(false); });
  });

  download.addEventListener('click', function () {
    if (mode === 'installed') {
      if (!window.confirm(tr('新版已下载。现在关闭工作台并安装更新？'))) return;
      api.install().catch(function (error) { statusText('安装未启动：{message}', { message: errorMessage(error) }); });
    } else if (downloadUrl) window.open(downloadUrl, '_blank', 'noopener,noreferrer');
  });

  document.getElementById('btnLocalUpdate').addEventListener('click', function () {
    busy(true);
    api.chooseLocal().then(function (result) {
      if (result.status === 'selected') {
        statusText('已定位新版 v{version}。请关闭当前窗口，双击选中的 EXE；确认正常后可删除旧版 EXE。', result);
      }
    }).catch(function (error) { statusText('选择失败：{message}', { message: errorMessage(error) }); })
      .finally(function () { busy(false); });
  });
})();
