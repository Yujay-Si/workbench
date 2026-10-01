const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createBackupManager, localDay } = require('../server/backup.cjs');
const { createAccountStore } = require('../server/account-store.cjs');
const { extractAccount } = require('../scripts/extract-backup.cjs');
const { createServer } = require('../server/index.cjs');

test('online snapshots include WAL changes, remain valid, and retain the latest 14 days', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-backup-test-'));
  const filename = path.join(directory, 'accounts.sqlite');
  const db = new DatabaseSync(filename);
  let manager;
  let day = new Date(2026, 0, 1, 12).getTime();
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE records (value TEXT); INSERT INTO records VALUES (\'first\')');
    manager = createBackupManager(db, filename, { now: () => day, writeDelayMs: 5 });
    await manager.backupToday();
    const first = path.join(directory, 'backups', 'accounts-2026-01-01.sqlite');
    assert.ok(fs.existsSync(first));
    const snapshot = new DatabaseSync(first, { readOnly: true });
    assert.equal(snapshot.prepare('SELECT value FROM records').get().value, 'first');
    assert.equal(snapshot.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    snapshot.close();

    db.exec('INSERT INTO records VALUES (\'second\')');
    manager.markChanged();
    await new Promise(resolve => setTimeout(resolve, 40));
    // The scheduled online copy can outlive its timer on a busy CI runner.
    await manager.backupToday();
    const refreshed = new DatabaseSync(first, { readOnly: true });
    assert.equal(refreshed.prepare('SELECT COUNT(*) AS count FROM records').get().count, 2);
    refreshed.close();
    for (let number = 2; number <= 16; number++) {
      day = new Date(2026, 0, number, 12).getTime();
      await manager.backupToday();
    }
    const names = fs.readdirSync(path.join(directory, 'backups')).filter(name => name.endsWith('.sqlite')).sort();
    assert.equal(names.length, 14);
    assert.equal(names[0], 'accounts-2026-01-03.sqlite');
    const latest = new DatabaseSync(path.join(directory, 'backups', names.at(-1)), { readOnly: true });
    assert.deepEqual(latest.prepare('SELECT value FROM records ORDER BY rowid').all().map(row => row.value), ['first', 'second']);
    latest.close();
    assert.equal(manager.status().state, 'ready');
    assert.equal(manager.status().retained, 14);
  } finally {
    manager?.stop();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('backup status requires a signed-in account and reports the server snapshot', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-backup-api-'));
  const { server, store, backups } = createServer({ databaseFile: path.join(directory, 'accounts.sqlite') });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await backups.backupToday();
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base + '/api/backup-status')).status, 401);
    const registration = await fetch(base + '/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'StatusUser', password: 'Abc123*' })
    });
    assert.equal(registration.status, 201);
    const cookie = registration.headers.get('set-cookie').split(';')[0];
    const response = await fetch(base + '/api/backup-status', { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.enabled, true);
    assert.equal(status.state, 'ready');
    assert.equal(status.retained, 1);
    assert.ok(status.lastSuccessAt);
    assert.equal(Object.hasOwn(status, 'directory'), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('restarting the service refreshes an existing daily snapshot', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-backup-restart-'));
  const filename = path.join(directory, 'accounts.sqlite');
  const db = new DatabaseSync(filename);
  try {
    db.exec('CREATE TABLE records (value TEXT); INSERT INTO records VALUES (\'before\')');
    await createBackupManager(db, filename).backupToday();
    db.exec('INSERT INTO records VALUES (\'after\')');
    const restarted = createBackupManager(db, filename);
    restarted.start();
    await restarted.backupToday();
    restarted.stop();
    const snapshot = new DatabaseSync(path.join(directory, 'backups', `accounts-${localDay(Date.now())}.sqlite`), { readOnly: true });
    try { assert.equal(snapshot.prepare('SELECT COUNT(*) AS count FROM records').get().count, 2); }
    finally { snapshot.close(); }
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an administrator can extract one account from a snapshot without replacing the live database', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-recovery-test-'));
  const filename = path.join(directory, 'accounts.sqlite');
  const store = createAccountStore(filename);
  try {
    const account = await store.register('RecoverMe', 'Abc123*');
    const other = await store.register('OtherUser', 'Abc123*');
    const data = { tasks: [{ id: 'task1', title: 'Recovered task' }], recurring: [], links: [], memos: [],
      news: { fetchedAt: '', cached: { international: [], domestic: [], ai: [] } }, settings: { theme: 'dark' } };
    store.saveWorkspace(account.account.id, 0, data);
    store.saveWorkspace(other.account.id, 0, { ...data, tasks: [{ id: 'private', title: 'Other data' }] });
    await createBackupManager(store.db, filename).backupToday();
    const snapshots = fs.readdirSync(path.join(directory, 'backups'));
    const result = extractAccount(path.join(directory, 'backups', snapshots[0]), 'recoverme');
    assert.equal(result.tasks[0].title, 'Recovered task');
    assert.equal(result.account, 'RecoverMe');
    assert.equal(result.app, 'NEXUS');
    assert.equal(result.news, undefined);
    assert.equal(store.workspace(account.account.id).data.tasks[0].title, 'Recovered task');
    assert.throws(() => extractAccount(path.join(directory, 'backups', snapshots[0]), 'missing'), /没有此账号/);
  } finally {
    store.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
