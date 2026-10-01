const fs = require('node:fs');
const path = require('node:path');

const LOCAL_SERVER = 'http://127.0.0.1:8768';

function validServerUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return '';
    if (url.protocol === 'https:') return url.origin;
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return url.origin;
    return '';
  } catch { return ''; }
}

function createAccountClient(configFile, fetchImpl = fetch) {
  let serverUrl = LOCAL_SERVER;
  let token = '';
  try {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    serverUrl = validServerUrl(config.url) || LOCAL_SERVER;
  } catch { /* First run uses local preview server. */ }

  function setServerUrl(value) {
    const url = validServerUrl(value);
    if (!url) throw new Error('服务器地址必须是 HTTPS，或本机 http://127.0.0.1 地址');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ url }, null, 2) + '\n', 'utf8');
    serverUrl = url;
    token = '';
    return { ok: true, url };
  }

  function useLocalUrl(url) {
    if (!validServerUrl(url) || !url.startsWith('http://127.0.0.1:')) throw new Error('本机服务地址无效');
    serverUrl = url;
    token = '';
  }

  async function request(method, route, body) {
    try {
      const response = await fetchImpl(serverUrl + route, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Cookie: `nexus_session=${token}` } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(15000)
      });
      const result = await response.json();
      if (response.ok && (route === '/api/login' || route === '/api/register')) {
        const match = /(?:^|\s)nexus_session=([A-Za-z0-9_-]{43})/.exec(response.headers.get('set-cookie') || '');
        if (!match) return { ok: false, code: 'SESSION', error: '服务器未返回登录凭据' };
        token = match[1];
      }
      if (route === '/api/logout' || response.status === 401) token = '';
      return { ok: response.ok, status: response.status, ...result };
    } catch (error) {
      return { ok: false, code: 'NETWORK', error: `连接服务器失败：${error.message}` };
    }
  }

  return {
    getServerUrl: () => ({ url: serverUrl }),
    setServerUrl,
    useLocalUrl,
    register: (username, password) => request('POST', '/api/register', { username, password }),
    login: (username, password) => request('POST', '/api/login', { username, password }),
    logout: () => request('POST', '/api/logout', {}),
    session: () => token ? request('GET', '/api/session') : Promise.resolve({ ok: true, account: null }),
    getWorkspace: () => request('GET', '/api/workspace'),
    saveWorkspace: (revision, data) => request('PUT', '/api/workspace', { revision, data }),
    backupStatus: () => request('GET', '/api/backup-status')
  };
}

module.exports = { LOCAL_SERVER, validServerUrl, createAccountClient };
