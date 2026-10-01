const assert = require('node:assert/strict');
const test = require('node:test');
const { createNexusSync } = require('../auth/sync.js');

test('sync queues edits made during a save and keeps the newest snapshot', async () => {
  let revision = 0;
  let release;
  const saved = [];
  const api = {
    workspace: async () => ({ ok: true, revision, data: null }),
    save: async (expected, data) => {
      if (!release) await new Promise(resolve => { release = resolve; });
      assert.equal(expected, revision);
      saved.push(data.value);
      return { ok: true, revision: ++revision };
    }
  };
  const sync = createNexusSync(api, () => {}, () => {});
  await sync.open();
  const first = sync.save({ value: 1 });
  sync.save({ value: 2 });
  release();
  assert.equal(await first, true);
  assert.deepEqual(saved, [1, 2]);
  assert.equal(sync.revision(), 2);
  assert.equal(sync.hasUnsaved(), false);
});

test('sync retains conflicting local data for backup', async () => {
  let received;
  const sync = createNexusSync({
    workspace: async () => ({ ok: true, revision: 3, data: { value: 'remote' } }),
    save: async () => ({ ok: false, code: 'CONFLICT', error: 'conflict' })
  }, data => { received = data; }, () => {});
  await sync.open();
  assert.equal(await sync.save({ value: 'local' }), false);
  assert.equal(sync.hasUnsaved(), true);
  assert.equal(sync.hasConflict(), true);
  assert.equal(await sync.poll(), false);
  assert.equal(received, undefined);
});

test('new edits during a conflict stay local until the user explicitly reloads', async () => {
  let saves = 0;
  let remote;
  const sync = createNexusSync({
    workspace: async () => ({ ok: true, revision: 4, data: { value: 'remote' } }),
    save: async () => { saves++; return { ok: false, code: 'CONFLICT', error: 'conflict' }; }
  }, data => { remote = data; }, () => {});
  await sync.open();
  assert.equal(await sync.save({ value: 'first local edit' }), false);
  assert.equal(await sync.save({ value: 'newer local edit' }), false);
  assert.equal(saves, 1);
  assert.equal(sync.hasUnsaved(), true);
  assert.equal(await sync.retry(), false);
  assert.equal(remote, undefined);
  await sync.discardAndReload();
  assert.equal(remote.value, 'remote');
  assert.equal(sync.hasUnsaved(), false);
});

test('retry checks the connection after a failed poll with no pending edits', async () => {
  let calls = 0;
  const sync = createNexusSync({
    workspace: async () => ({ ok: ++calls !== 2, revision: 0, data: null }),
    save: async () => ({ ok: true, revision: 1 })
  }, () => {}, () => {});
  await sync.open();
  assert.equal(await sync.poll(), false);
  assert.equal(await sync.retry(), true);
  assert.equal(calls, 3);
});
