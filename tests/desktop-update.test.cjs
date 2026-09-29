const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const update = require('../desktop/update.cjs');

test('compares strict release versions and filename format', () => {
  assert.equal(update.isNewer('1.0.1', '1.0.0'), true);
  assert.equal(update.isNewer('1.0.0', '1.0.0'), false);
  assert.equal(update.isNewer('1.0.0-rc1', '1.0.0'), false);
  assert.equal(update.versionFromFilename('NEXUS-Workbench-1.2.3-win-x64.exe'), '1.2.3');
  assert.equal(update.versionFromFilename('Other-1.2.3.exe'), '');
});

test('stores only HTTPS feed URLs outside the executable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-update-'));
  try {
    const file = path.join(dir, 'update.json');
    assert.throws(() => update.saveFeed(file, 'http://example.com/latest.json'), /HTTPS/);
    assert.throws(() => update.saveFeed(file, 'https://user:pass@example.com/latest.json'), /HTTPS/);
    update.saveFeed(file, 'https://example.com/latest.json');
    assert.equal(update.readFeed(file), 'https://example.com/latest.json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checks a release feed and rejects unsafe download links', async () => {
  const headers = { get: () => null };
  const response = (data) => ({
    url: 'https://example.com/latest.json', ok: true, headers,
    text: async () => JSON.stringify(data)
  });
  const good = { version: '1.1.0', downloadUrl: 'https://example.com/NEXUS-Workbench-1.1.0-win-x64.exe' };
  assert.equal((await update.checkFeed('https://example.com/latest.json', '1.0.0', async () => response(good))).status, 'available');
  await assert.rejects(
    update.checkFeed('https://example.com/latest.json', '1.0.0', async () => response({ ...good, downloadUrl: 'file:///bad.exe' })),
    /下载地址无效/
  );
});
