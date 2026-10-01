const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[\p{L}\p{N}]{1,32}$/u;
const REGISTER_USERNAME_RE = /^[\p{L}\p{N}]{1,12}$/u;
const ID_RE = /^[a-z0-9_-]{1,80}$/i;
const SCRYPT_OPTIONS = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

class AccountError extends Error {
  constructor(code, message, status = 400, detail = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

function normalizedUsername(value, registration = false) {
  const limit = registration ? 12 : 32;
  if (typeof value !== 'string') throw new AccountError('USERNAME_INVALID', `用户名须为 1–${limit} 位文字或数字`);
  const name = value.normalize('NFC').trim();
  if (!(registration ? REGISTER_USERNAME_RE : USERNAME_RE).test(name)) {
    throw new AccountError('USERNAME_INVALID', `用户名须为 1–${limit} 位文字或数字`);
  }
  return { name, key: name.toLowerCase() };
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 6 || value.length > 128 || /\s/u.test(value)) {
    throw new AccountError('PASSWORD_INVALID', '密码须至少 6 位、最多 128 位且不能含空格');
  }
  const types = [/[A-Z]/.test(value), /[a-z]/.test(value), /[0-9]/.test(value), /[\p{P}\p{S}]/u.test(value)];
  if (types.filter(Boolean).length < 3 || /[^\p{L}\p{N}\p{P}\p{S}]/u.test(value)) {
    throw new AccountError('PASSWORD_INVALID', '密码须包含大写、小写、数字、特殊符号中的至少三类');
  }
  return value;
}

function derive(password, salt) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, SCRYPT_OPTIONS,
    (error, key) => error ? reject(error) : resolve(key)));
}

function safeWorkspace(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AccountError('DATA_INVALID', '工作台数据格式错误');
  }
  const lists = {};
  for (const key of ['tasks', 'recurring', 'links', 'memos']) {
    if (!Array.isArray(input[key]) || input[key].length > 50000) {
      throw new AccountError('DATA_INVALID', `${key} 数据格式错误`);
    }
    const seen = new Set();
    lists[key] = input[key].map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !ID_RE.test(row.id) || seen.has(row.id)) {
        throw new AccountError('DATA_INVALID', `${key} 记录 ID 无效或重复`);
      }
      seen.add(row.id);
      return row;
    });
  }
  const settings = input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings) ? input.settings : {};
  const payload = {
    ...lists,
    settings: {
      lastRollover: settings.lastRollover || '',
      appPack: Number(settings.appPack) || 0,
      memoSeed: Number(settings.memoSeed) || 0,
      theme: ['dark', 'light', 'auto'].includes(settings.theme) ? settings.theme : 'dark',
      language: settings.language === 'en-US' ? 'en-US' : 'zh-CN'
    }
  };
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > 10 * 1024 * 1024) {
    throw new AccountError('DATA_TOO_LARGE', '工作台数据超过 10 MB');
  }
  return serialized;
}

function createAccountStore(filename, options = {}) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      failures INTEGER NOT NULL DEFAULT 0,
      stage INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0,
      permanent INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );`);
  if (filename !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const now = options.now || Date.now;
  const userByKey = db.prepare('SELECT * FROM accounts WHERE username_key = ?');
  const userById = db.prepare('SELECT id, username, permanent FROM accounts WHERE id = ?');
  const sessionByHash = db.prepare('SELECT account_id, expires_at FROM sessions WHERE token_hash = ?');
  const workspaceByUser = db.prepare('SELECT revision, payload FROM workspaces WHERE account_id = ?');
  const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

  function issueSession(accountId) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions(token_hash, account_id, expires_at) VALUES (?, ?, ?)')
      .run(hashToken(token), accountId, now() + SESSION_MS);
    return token;
  }

  async function register(username, password) {
    const { name, key } = normalizedUsername(username, true);
    validatePassword(password);
    if (userByKey.get(key)) throw new AccountError('USERNAME_TAKEN', '用户名已存在', 409);
    const salt = crypto.randomBytes(16).toString('base64');
    const hash = (await derive(password, Buffer.from(salt, 'base64'))).toString('base64');
    let id;
    try {
      db.exec('BEGIN IMMEDIATE');
      id = Number(db.prepare('INSERT INTO accounts(username, username_key, salt, password_hash) VALUES (?, ?, ?, ?)')
        .run(name, key, salt, hash).lastInsertRowid);
      db.prepare('INSERT INTO workspaces(account_id, revision, payload) VALUES (?, 0, ?)').run(id, '');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      if (String(error.message).includes('UNIQUE')) throw new AccountError('USERNAME_TAKEN', '用户名已存在', 409);
      throw error;
    }
    return { token: issueSession(id), account: { id, username: name } };
  }

  async function login(username, password) {
    let key;
    try { key = normalizedUsername(username).key; }
    catch { key = ''; }
    const user = key ? userByKey.get(key) : null;
    if (user && user.permanent) throw new AccountError('LOCKED_PERMANENT', '账号已永久锁定，请使用事先导出的备份注册新账号恢复', 423);
    if (user && user.locked_until > now()) {
      throw new AccountError('LOCKED_TEMP', '账号暂时锁定', 423, { retryAfterSeconds: Math.ceil((user.locked_until - now()) / 1000) });
    }
    const salt = user ? Buffer.from(user.salt, 'base64') : Buffer.alloc(16);
    const actual = await derive(typeof password === 'string' ? password : '', salt);
    const expected = user ? Buffer.from(user.password_hash, 'base64') : Buffer.alloc(64);
    const valid = user && expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    const latest = user ? userByKey.get(key) : null;
    if (latest && latest.permanent) throw new AccountError('LOCKED_PERMANENT', '账号已永久锁定，请使用事先导出的备份注册新账号恢复', 423);
    if (latest && latest.locked_until > now()) {
      throw new AccountError('LOCKED_TEMP', '账号暂时锁定', 423, { retryAfterSeconds: Math.ceil((latest.locked_until - now()) / 1000) });
    }
    if (!valid) {
      if (user) {
        let lockError = null;
        db.exec('BEGIN IMMEDIATE');
        try {
          const current = userByKey.get(key);
          if (current.permanent) throw new AccountError('LOCKED_PERMANENT', '账号已永久锁定', 423);
          if (current.locked_until > now()) throw new AccountError('LOCKED_TEMP', '账号暂时锁定', 423,
            { retryAfterSeconds: Math.ceil((current.locked_until - now()) / 1000) });
          const failures = current.failures + 1;
          if (failures > 3) {
            const stage = current.stage + 1;
            const until = stage === 1 ? now() + 60000 : (stage === 2 ? now() + 600000 : 0);
            db.prepare('UPDATE accounts SET failures=0, stage=?, locked_until=?, permanent=? WHERE id=?')
              .run(stage, until, stage >= 3 ? 1 : 0, current.id);
            if (stage >= 3) db.prepare('DELETE FROM sessions WHERE account_id=?').run(current.id);
            lockError = stage >= 3
              ? new AccountError('LOCKED_PERMANENT', '账号已永久锁定，请使用事先导出的备份注册新账号恢复', 423)
              : new AccountError('LOCKED_TEMP', '账号暂时锁定', 423,
                { retryAfterSeconds: stage === 1 ? 60 : 600 });
          } else {
            db.prepare('UPDATE accounts SET failures=? WHERE id=?').run(failures, current.id);
          }
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        if (lockError) throw lockError;
      }
      throw new AccountError('LOGIN_FAILED', '用户名或密码错误', 401);
    }
    db.prepare('UPDATE accounts SET failures=0, stage=0, locked_until=0 WHERE id=?').run(user.id);
    return { token: issueSession(user.id), account: { id: user.id, username: user.username } };
  }

  function session(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = sessionByHash.get(hashToken(token));
    if (!row || row.expires_at <= now()) return null;
    const account = userById.get(row.account_id);
    return account && !account.permanent ? { id: account.id, username: account.username } : null;
  }

  function logout(token) {
    if (typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    }
  }

  function workspace(accountId) {
    const row = workspaceByUser.get(accountId);
    if (!row) throw new AccountError('NOT_FOUND', '账号数据不存在', 404);
    return { revision: row.revision, data: row.payload ? JSON.parse(row.payload) : null };
  }

  function saveWorkspace(accountId, revision, data) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new AccountError('REVISION_INVALID', '同步版本无效');
    const payload = safeWorkspace(data);
    const result = db.prepare('UPDATE workspaces SET revision = revision + 1, payload = ? WHERE account_id = ? AND revision = ?')
      .run(payload, accountId, revision);
    if (!result.changes) throw new AccountError('CONFLICT', '另一台设备已修改数据，请先处理同步冲突', 409);
    return { revision: revision + 1 };
  }

  return { db, register, login, session, logout, workspace, saveWorkspace };
}

module.exports = { AccountError, createAccountStore, normalizedUsername, validatePassword, safeWorkspace };
