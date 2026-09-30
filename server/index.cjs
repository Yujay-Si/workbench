const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AccountError, createAccountStore } = require('./account-store.cjs');

const ROOT = path.join(__dirname, '..');
const STATIC = Object.freeze({
  '/': ['nexus-workbench.html', 'text/html; charset=utf-8'],
  '/nexus-workbench.html': ['nexus-workbench.html', 'text/html; charset=utf-8'],
  '/desktop/ui.js': ['desktop/ui.js', 'text/javascript; charset=utf-8'],
  '/auth/client.js': ['auth/client.js', 'text/javascript; charset=utf-8']
  ,'/auth/sync.js': ['auth/sync.js', 'text/javascript; charset=utf-8']
});
const COOKIE = 'nexus_session';

function readJson(request) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
      reject(new AccountError('CONTENT_TYPE', '仅接受 JSON 请求', 415));
      return;
    }
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 11 * 1024 * 1024) {
        reject(new AccountError('TOO_LARGE', '请求内容超过 11 MB', 413));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
        resolve(value);
      } catch { reject(new AccountError('BAD_JSON', '请求 JSON 格式错误')); }
    });
    request.on('error', reject);
  });
}

function cookieToken(request) {
  const raw = request.headers.cookie || '';
  const part = raw.split(';').map((value) => value.trim()).find((value) => value.startsWith(COOKIE + '='));
  return part ? part.slice(COOKIE.length + 1) : '';
}

function createServer(options = {}) {
  const store = options.store || createAccountStore(options.databaseFile || path.join(os.homedir(), 'NEXUS-Workbench-Server', 'accounts.sqlite'));
  const publicUrl = options.publicUrl || '';
  const expectedOrigin = publicUrl ? new URL(publicUrl).origin : '';
  const secureCookie = expectedOrigin.startsWith('https://');

  function send(response, status, value, extra = {}) {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra
    });
    response.end(JSON.stringify(value));
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/')) {
        const asset = STATIC[url.pathname];
        if (request.method !== 'GET' || !asset) { send(response, 404, { error: 'Not found' }); return; }
        const filename = path.join(ROOT, asset[0]);
        response.writeHead(200, {
          'Content-Type': asset[1],
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://v.juhe.cn; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        });
        fs.createReadStream(filename).pipe(response);
        return;
      }
      if (!['GET', 'POST', 'PUT'].includes(request.method)) { send(response, 405, { error: 'Method not allowed' }); return; }
      if (request.method !== 'GET' && request.headers.origin) {
        const allowed = expectedOrigin || `http://${request.headers.host}`;
        if (request.headers.origin !== allowed) throw new AccountError('ORIGIN', '请求来源无效', 403);
      }
      if (url.pathname === '/api/register' && request.method === 'POST') {
        const body = await readJson(request);
        const result = await store.register(body.username, body.password);
        send(response, 201, { account: result.account }, { 'Set-Cookie': `${COOKIE}=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secureCookie ? '; Secure' : ''}` });
        return;
      }
      if (url.pathname === '/api/login' && request.method === 'POST') {
        const body = await readJson(request);
        const result = await store.login(body.username, body.password);
        send(response, 200, { account: result.account }, { 'Set-Cookie': `${COOKIE}=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secureCookie ? '; Secure' : ''}` });
        return;
      }
      const token = cookieToken(request);
      const account = store.session(token);
      if (url.pathname === '/api/session' && request.method === 'GET') {
        send(response, 200, { account: account ? { id: account.id, username: account.username } : null });
        return;
      }
      if (!account) throw new AccountError('UNAUTHORIZED', '请先登录', 401);
      if (url.pathname === '/api/logout' && request.method === 'POST') {
        store.logout(token);
        send(response, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie ? '; Secure' : ''}` });
        return;
      }
      if (url.pathname === '/api/workspace' && request.method === 'GET') {
        send(response, 200, store.workspace(account.id));
        return;
      }
      if (url.pathname === '/api/workspace' && request.method === 'PUT') {
        const body = await readJson(request);
        send(response, 200, store.saveWorkspace(account.id, body.revision, body.data));
        return;
      }
      send(response, 404, { error: 'Not found' });
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        const known = error instanceof AccountError;
        send(response, known ? error.status : 500, {
          code: known ? error.code : 'SERVER_ERROR',
          error: known ? error.message : '服务器发生错误',
          ...(known ? error.detail : {})
        });
      }
      if (!(error instanceof AccountError)) console.error('request failed:', error);
    }
  });
  return { server, store };
}

if (require.main === module) {
  const port = Number(process.env.NEXUS_PORT || 8768);
  const host = process.env.NEXUS_BIND || '127.0.0.1';
  const databaseFile = process.env.NEXUS_DB_FILE || path.join(os.homedir(), 'NEXUS-Workbench-Server', 'accounts.sqlite');
  const { server } = createServer({ databaseFile, publicUrl: process.env.NEXUS_PUBLIC_URL || '' });
  server.listen(port, host, () => console.log(`NEXUS preview: http://${host}:${port}/nexus-workbench.html`));
}

module.exports = { createServer };
