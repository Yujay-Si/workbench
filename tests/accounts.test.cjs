const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAccountStore, validatePassword, safeWorkspace } = require('../server/account-store.cjs');
const { createServer } = require('../server/index.cjs');

function emptyData() {
  return { tasks: [], recurring: [], links: [], memos: [], news: { cached: {} }, settings: {} };
}

test('registration accepts text or numeric usernames and requires three password categories', async () => {
  const store = createAccountStore(':memory:');
  try {
    assert.equal((await store.register('张三123', 'Abc123*')).account.username, '张三123');
    assert.equal((await store.register('12345', 'Abc123，')).account.username, '12345');
    await assert.rejects(store.register('张三123', 'Abc123*'), { code: 'USERNAME_TAKEN' });
    assert.throws(() => validatePassword('abcdef'), { code: 'PASSWORD_INVALID' });
    assert.throws(() => validatePassword('12345'), { code: 'PASSWORD_INVALID' });
  } finally { store.db.close(); }
});

test('four failures cause one minute, then ten minutes, then permanent lock across restarts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-accounts-'));
  const file = path.join(dir, 'accounts.sqlite');
  let time = 1000000;
  let store = createAccountStore(file, { now: () => time });
  try {
    const original = await store.register('LockUser', 'Abc123*');
    for (let stage = 1; stage <= 3; stage++) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await assert.rejects(store.login('lockuser', 'Wrong123*'), { code: 'LOGIN_FAILED' });
      }
      await assert.rejects(store.login('LockUser', 'Wrong123*'), {
        code: stage === 3 ? 'LOCKED_PERMANENT' : 'LOCKED_TEMP'
      });
      if (stage === 1) {
        await assert.rejects(store.login('LockUser', 'Abc123*'), { code: 'LOCKED_TEMP' });
        store.db.close();
        store = createAccountStore(file, { now: () => time });
        time += 60000;
      } else if (stage === 2) {
        time += 600000;
      }
    }
    await assert.rejects(store.login('LockUser', 'Abc123*'), { code: 'LOCKED_PERMANENT' });
    assert.equal(store.session(original.token), null);
  } finally {
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a successful login resets the staged failure count', async () => {
  let time = 1000000;
  const store = createAccountStore(':memory:', { now: () => time });
  try {
    await store.register('reset', 'Abc123*');
    for (let i = 0; i < 4; i++) await assert.rejects(store.login('reset', 'Wrong123*'));
    time += 60000;
    assert.equal((await store.login('reset', 'Abc123*')).account.username, 'reset');
    for (let i = 0; i < 3; i++) await assert.rejects(store.login('reset', 'Wrong123*'), { code: 'LOGIN_FAILED' });
    await assert.rejects(store.login('reset', 'Wrong123*'), { code: 'LOCKED_TEMP' });
    const row = store.db.prepare('SELECT stage FROM accounts WHERE username_key=?').get('reset');
    assert.equal(row.stage, 1);
  } finally { store.db.close(); }
});

test('workspace snapshots omit credentials and reject stale revisions', async () => {
  const store = createAccountStore(':memory:');
  try {
    const a = await store.register('userA', 'Abc123*');
    const b = await store.register('userB', 'Abc123*');
    const data = emptyData();
    data.tasks.push({ id: 'task1', title: 'A only' });
    data.settings.password = '0000';
    data.news.key = 'secret-news-key';
    assert.equal(store.saveWorkspace(a.account.id, 0, data).revision, 1);
    assert.equal(store.workspace(b.account.id).data, null);
    assert.equal(store.workspace(a.account.id).data.tasks[0].title, 'A only');
    assert.equal(store.workspace(a.account.id).data.settings.password, undefined);
    assert.equal(store.workspace(a.account.id).data.news.key, undefined);
    assert.throws(() => store.saveWorkspace(a.account.id, 0, emptyData()), { code: 'CONFLICT' });
    assert.equal(store.session(a.token).id, a.account.id);
    store.logout(a.token);
    assert.equal(store.session(a.token), null);
    assert.throws(() => safeWorkspace({ tasks: [], recurring: [], links: [{ id: 'bad" onclick="x' }], memos: [] }), { code: 'DATA_INVALID' });
  } finally { store.db.close(); }
});

test('HTTP API uses the session owner and does not let another account read its data', async () => {
  const store = createAccountStore(':memory:');
  const { server } = createServer({ store });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, value, cookie) => fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(value)
  });
  try {
    assert.equal((await fetch(base + '/api/workspace')).status, 401);
    const first = await post('/api/register', { username: 'first', password: 'Abc123*' });
    assert.equal(first.status, 201);
    const firstCookie = first.headers.get('set-cookie').split(';')[0];
    const data = emptyData();
    data.memos.push({ id: 'private', title: '私有记录' });
    const saved = await fetch(base + '/api/workspace', {
      method: 'PUT', headers: { Cookie: firstCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: 0, data })
    });
    assert.equal(saved.status, 200);
    const second = await post('/api/register', { username: 'second', password: 'Abc123*' });
    const secondCookie = second.headers.get('set-cookie').split(';')[0];
    const other = await fetch(base + '/api/workspace', { headers: { Cookie: secondCookie } });
    assert.equal((await other.json()).data, null);
    const own = await fetch(base + '/api/workspace', { headers: { Cookie: firstCookie } });
    assert.equal((await own.json()).data.memos[0].title, '私有记录');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.db.close();
  }
});
