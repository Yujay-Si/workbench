(function (root, factory) {
  var exported = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.createNexusSync = exported.createNexusSync;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';

  function createNexusSync(api, onRemote, onStatus) {
    var revision = 0;
    var pending = null;
    var running = null;
    var conflict = false;
    var queued = false;

    function snapshot(data) {
      return JSON.parse(JSON.stringify(data));
    }

    async function open() {
      var result = await api.workspace();
      if (!result.ok) throw new Error(result.error || '读取工作台失败');
      revision = result.revision;
      pending = null;
      conflict = false;
      return result.data;
    }

    async function flush() {
      while (pending) {
        var sending = pending;
        pending = null;
        var result = await api.save(revision, sending);
        if (!result.ok) {
          if (!pending) pending = sending;
          conflict = result.code === 'CONFLICT';
          onStatus(conflict ? 'conflict' : 'offline', result.error || '同步失败');
          return false;
        }
        revision = result.revision;
      }
      conflict = false;
      onStatus('saved', '已同步');
      return true;
    }

    function start() {
      if (!running) {
        queued = false;
        running = flush().finally(function () {
        running = null;
        // A save can arrive after flush's last check and before its promise settles.
        if (pending && queued && !conflict) return start();
        });
      }
      return running;
    }

    function save(data) {
      pending = snapshot(data);
      onStatus('saving', '正在同步…');
      if (conflict) {
        onStatus('conflict', '另一台设备已修改数据，请先处理同步冲突');
        return Promise.resolve(false);
      }
      if (running) queued = true;
      return start();
    }

    async function retry() {
      if (conflict) return false;
      if (!pending) return poll();
      return start();
    }

    async function poll() {
      if (pending || running) return false;
      var result = await api.workspace();
      if (!result.ok) { onStatus('offline', result.error || '连接服务器失败'); return false; }
      if (pending || running) return false;
      if (result.revision > revision) {
        revision = result.revision;
        onRemote(result.data);
      }
      onStatus('saved', '已同步');
      return true;
    }

    async function discardAndReload() {
      if (running) await running;
      var result = await api.workspace();
      if (!result.ok) throw new Error(result.error || '读取云端数据失败');
      revision = result.revision;
      pending = null;
      conflict = false;
      onRemote(result.data);
      onStatus('saved', '已同步');
    }

    return {
      open: open, save: save, retry: retry, poll: poll, discardAndReload: discardAndReload,
      hasUnsaved: function () { return !!pending || !!running; },
      hasConflict: function () { return conflict; },
      revision: function () { return revision; }
    };
  }

  return { createNexusSync: createNexusSync };
});
