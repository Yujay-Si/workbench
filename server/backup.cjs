const { DatabaseSync, backup } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RETAIN = 14;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const WRITE_DELAY_MS = 2 * 60 * 1000;

function localDay(now) {
  const date = new Date(now);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function createBackupManager(db, databaseFile, options = {}) {
  if (!db || !databaseFile || databaseFile === ':memory:') throw new Error('On-disk SQLite database required');
  const directory = path.join(path.dirname(databaseFile), 'backups');
  const prefix = path.basename(databaseFile, path.extname(databaseFile)) + '-';
  const now = options.now || Date.now;
  const keep = options.retain || RETAIN;
  let timer = null;
  let writeTimer = null;
  let running = null;
  let lastSuccessAt = '';
  let state = 'pending';
  let error = '';
  let retained = 0;

  async function snapshots() {
    const names = await fs.promises.readdir(directory).catch((readError) => {
      if (readError.code === 'ENOENT') return [];
      throw readError;
    });
    return names.filter((name) => name.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}\.sqlite$/.test(name.slice(prefix.length))).sort();
  }

  async function backupToday(refresh = false) {
    if (running) {
      await running;
      return refresh ? backupToday(true) : status();
    }
    running = (async () => {
      state = 'running';
      error = '';
      let temporary = '';
      try {
        await fs.promises.mkdir(directory, { recursive: true });
        const target = path.join(directory, prefix + localDay(now()) + '.sqlite');
        if (refresh || !(await fs.promises.stat(target).then(() => true, () => false))) {
          temporary = target + '.' + process.pid + '-' + crypto.randomBytes(6).toString('hex') + '.tmp';
          // SQLite's online backup API includes committed WAL pages in a consistent snapshot.
          await backup(db, temporary);
          const check = new DatabaseSync(temporary, { readOnly: true });
          try {
            if (check.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('SQLite quick_check failed');
          } finally { check.close(); }
          await fs.promises.rename(temporary, target);
          temporary = '';
        }
        const names = await snapshots();
        for (const name of names.slice(0, Math.max(0, names.length - keep))) {
          await fs.promises.unlink(path.join(directory, name));
        }
        const kept = await snapshots();
        retained = kept.length;
        const latest = kept[kept.length - 1];
        lastSuccessAt = latest ? (await fs.promises.stat(path.join(directory, latest))).mtime.toISOString() : '';
        state = 'ready';
        return status();
      } catch (cause) {
        state = 'error';
        error = '自动备份失败，请检查服务器磁盘空间和目录权限';
        console.error('NEXUS backup failed:', cause);
        throw cause;
      } finally {
        if (temporary) await fs.promises.unlink(temporary).catch(() => {});
      }
    })().finally(() => { running = null; });
    return running;
  }

  function start() {
    if (timer) return;
    // Refresh even when today's file exists: the process may have stopped before a queued write was copied.
    backupToday(true).catch(() => {});
    timer = setInterval(() => backupToday().catch(() => {}), CHECK_INTERVAL_MS);
    timer.unref?.();
  }

  function markChanged() {
    if (writeTimer) return;
    // Coalesce rapid edits so the current day's snapshot catches up without copying the DB for every keystroke.
    writeTimer = setTimeout(() => {
      writeTimer = null;
      backupToday(true).catch(() => {});
    }, options.writeDelayMs ?? WRITE_DELAY_MS);
    writeTimer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = null;
  }

  function status() {
    return { enabled: true, state, lastSuccessAt, retained, pendingChanges: Boolean(writeTimer), error };
  }

  return { start, stop, markChanged, backupToday, status, directory };
}

module.exports = { createBackupManager, localDay };
