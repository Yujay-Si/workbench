const fs = require('node:fs');
const path = require('node:path');

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value || ''));
  return match ? match.slice(1).map(Number) : null;
}

function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function validHttpsUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url.href : '';
  } catch {
    return '';
  }
}

function readFeed(configPath) {
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return validHttpsUrl(data.feedUrl);
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw new Error('更新配置读取失败：' + error.message);
  }
}

function saveFeed(configPath, value) {
  const feedUrl = String(value || '').trim();
  if (feedUrl && !validHttpsUrl(feedUrl)) throw new Error('更新地址必须是有效的 HTTPS 网址');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temp = configPath + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ feedUrl }, null, 2), 'utf8');
  fs.renameSync(temp, configPath);
  return feedUrl;
}

async function checkFeed(feedUrl, currentVersion, fetchImpl = fetch) {
  if (!feedUrl) return { status: 'unconfigured', currentVersion };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetchImpl(feedUrl, { signal: controller.signal, redirect: 'follow' });
    if (!validHttpsUrl(response.url || feedUrl)) throw new Error('更新地址跳转到了非 HTTPS 页面');
    if (!response.ok) throw new Error('更新服务返回 HTTP ' + response.status);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 65536) throw new Error('更新清单过大');
    const body = await response.text();
    if (body.length > 65536) throw new Error('更新清单过大');
    const data = JSON.parse(body);
    if (!parseVersion(data.version)) throw new Error('更新清单中的版本号无效');
    const downloadUrl = validHttpsUrl(data.downloadUrl);
    if (!downloadUrl) throw new Error('更新清单中的下载地址无效');
    return {
      status: isNewer(data.version, currentVersion) ? 'available' : 'latest',
      currentVersion,
      version: data.version,
      downloadUrl
    };
  } finally {
    clearTimeout(timeout);
  }
}

function versionFromFilename(filename) {
  const match = /^NEXUS-Workbench-(\d+\.\d+\.\d+)-win-x64\.exe$/i.exec(path.basename(filename));
  return match ? match[1] : '';
}

module.exports = { parseVersion, isNewer, validHttpsUrl, readFeed, saveFeed, checkFeed, versionFromFilename };
