const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validExecutable } = require('../desktop/local-apps.cjs');

test('desktop launcher accepts only installed executables from its allowlist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-apps-'));
  try {
    const qq = path.join(dir, 'QQ.exe');
    const other = path.join(dir, 'other.exe');
    fs.writeFileSync(qq, '');
    fs.writeFileSync(other, '');
    assert.equal(validExecutable('qq', qq), qq);
    assert.equal(validExecutable('wechat', qq), '');
    assert.equal(validExecutable('qq', other), '');
    assert.equal(validExecutable('qq', path.join(dir, 'missing', 'QQ.exe')), '');
    assert.equal(validExecutable('unknown', qq), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
