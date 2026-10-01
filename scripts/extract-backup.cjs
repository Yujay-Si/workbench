const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

function extractAccount(backupFile, username) {
  if (!backupFile || !username) throw new Error('备份文件和用户名不能为空');
  const db = new DatabaseSync(path.resolve(backupFile), { readOnly: true });
  try {
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('备份文件未通过完整性检查');
    const key = String(username).normalize('NFC').trim().toLowerCase();
    const row = db.prepare(`SELECT accounts.username, workspaces.payload
      FROM accounts JOIN workspaces ON workspaces.account_id = accounts.id
      WHERE accounts.username_key = ?`).get(key);
    if (!row || !row.payload) throw new Error('该快照中没有此账号的工作台数据');
    return { ...JSON.parse(row.payload), app: 'NEXUS', version: 2, account: row.username,
      exportedAt: new Date().toISOString() };
  } finally { db.close(); }
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 6 || args[0] !== '--backup' || args[2] !== '--username' || args[4] !== '--output') {
      throw new Error('用法：node scripts/extract-backup.cjs --backup 快照.sqlite --username 用户名 --output 恢复.json');
    }
    const result = extractAccount(args[1], args[3]);
    fs.writeFileSync(path.resolve(args[5]), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log('已生成账号 JSON 备份：' + path.resolve(args[5]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { extractAccount };
