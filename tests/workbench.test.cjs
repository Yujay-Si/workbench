const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadWorkbench() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'nexus-workbench.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(
    /\}\)\(\);\s*$/,
    'globalThis.workbenchTest = { state, Store, commit, seedData, newsItems, setTaskStatus, rolloverOverdue, generateRecurring, normalizeImport: typeof normalizeImport === "function" ? normalizeImport : undefined, safeHttpUrl: typeof safeHttpUrl === "function" ? safeHttpUrl : undefined, taskDelayDays: typeof taskDelayDays === "function" ? taskDelayDays : undefined, searchRecords: typeof searchRecords === "function" ? searchRecords : undefined, searchResultHTML: typeof searchResultHTML === "function" ? searchResultHTML : undefined, addDays, todayStr };})();'
  );
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
  const context = {
    console,
    Date,
    URL,
    Math,
    setTimeout,
    clearTimeout,
    localStorage: storage,
    sessionStorage: storage,
    document: { readyState: 'loading', addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } },
    window: {}
  };
  vm.runInNewContext(script, context, { filename: 'nexus-workbench.html' });
  return { ...context.workbenchTest, storage };
}

test('a fresh workbench contains no demonstration records or news', () => {
  const wb = loadWorkbench();
  const initial = wb.seedData();
  assert.equal(initial.tasks.length, 0);
  assert.equal(initial.recurring.length, 0);
  assert.equal(initial.memos.length, 0);
  assert.ok(initial.links.every(link => !link.demo));
  assert.equal(wb.newsItems('international').length, 0);
});

test('completing a repeated task twice generates one successor', () => {
  const wb = loadWorkbench();
  wb.state.tasks = [{ id: 'first', title: '日报', due: wb.todayStr(), repeat: 'daily', status: 'todo' }];
  wb.setTaskStatus('first', 'done');
  wb.setTaskStatus('first', 'done');
  assert.equal(wb.state.tasks.length, 2);
});

test('opening the workbench preserves the original overdue date', () => {
  const wb = loadWorkbench();
  const due = wb.addDays(wb.todayStr(), -2);
  wb.state.tasks = [{ id: 'old', due, status: 'todo', deferred: 0 }];
  wb.state.settings.lastRollover = '';
  wb.rolloverOverdue();
  assert.equal(wb.state.tasks[0].due, due);
});

test('daily recurring rules catch up after days without opening', () => {
  const wb = loadWorkbench();
  wb.state.recurring = [{ id: 'rule', title: '日报', freq: 'daily', priority: 'P1', lastDate: wb.addDays(wb.todayStr(), -3) }];
  wb.generateRecurring();
  assert.deepEqual(Array.from(wb.state.tasks, task => task.due), [
    wb.addDays(wb.todayStr(), -2), wb.addDays(wb.todayStr(), -1), wb.todayStr()
  ]);
});

test('import rejects malformed collections before replacing state', () => {
  const wb = loadWorkbench();
  assert.throws(() => wb.normalizeImport({ app: 'NEXUS', tasks: { bad: true } }), /任务/);
  assert.throws(() => wb.normalizeImport({ app: 'NEXUS', tasks: [{ id: 'x', title: 'X', status: 'broken' }] }), /状态/);
});

test('links from imported data accept only http and https URLs', () => {
  const wb = loadWorkbench();
  assert.equal(wb.safeHttpUrl('javascript:alert(1)'), '');
  assert.equal(wb.safeHttpUrl('https://example.com'), 'https://example.com/');
});

test('saving the workbench does not persist the news API key in main data', () => {
  const wb = loadWorkbench();
  wb.state.news.key = 'private-key';
  assert.equal(wb.Store.save(wb.state), true);
  assert.equal(JSON.parse(wb.storage.getItem('wb_nexus_v1')).news.key, undefined);
});

test('overdue duration is calculated without changing the due date', () => {
  const wb = loadWorkbench();
  const task = { due: wb.addDays(wb.todayStr(), -2), status: 'todo', deferred: 0 };
  assert.equal(wb.taskDelayDays(task), 2);
  assert.equal(task.due, wb.addDays(wb.todayStr(), -2));
});

test('commit reports a failed browser save', () => {
  const wb = loadWorkbench();
  wb.storage.setItem = () => { throw new Error('quota exceeded'); };
  assert.equal(wb.commit(), false);
});

test('import rejects attribute injection in record identifiers', () => {
  const wb = loadWorkbench();
  assert.throws(() => wb.normalizeImport({ tasks: [{ id: 'x" onclick="alert(1)', title: '任务' }] }), /ID/);
});

test('invalid local data is not overwritten with demo content', () => {
  const wb = loadWorkbench();
  wb.storage.setItem('wb_nexus_v1', '{broken json');
  assert.equal(wb.Store.load(), null);
  assert.equal(wb.Store.save(wb.state), false);
  assert.equal(wb.storage.getItem('wb_nexus_v1'), '{broken json');
});

test('wrong-shaped local data is also preserved for recovery', () => {
  const wb = loadWorkbench();
  wb.storage.setItem('wb_nexus_v1', '{"tasks":{"not":"a list"}}');
  assert.equal(wb.Store.load(), null);
  assert.equal(wb.Store.save(wb.state), false);
});

test('weekly catch-up generates only scheduled dates and remains idempotent', () => {
  const wb = loadWorkbench();
  const today = wb.todayStr();
  const last = wb.addDays(today, -14);
  const weekday = new Date(`${today}T12:00:00`).getDay();
  wb.state.recurring = [{ id: 'weekly', title: '周任务', freq: 'weekly', weekday, lastDate: last }];
  assert.equal(wb.generateRecurring(), 2);
  assert.equal(wb.generateRecurring(), 0);
});

test('an older valid backup remains importable', () => {
  const wb = loadWorkbench();
  const backup = {
    app: 'NEXUS', version: 1,
    tasks: [{ id: 'task1', title: '旧任务', due: wb.todayStr(), priority: 'P1', status: 'todo' }],
    recurring: [{ id: 'rule1', title: '周报', freq: 'weekly', weekday: 5, monthday: 0, lastDate: '' }],
    links: [{ id: 'link1', name: '官网', url: 'https://example.com/', protocol: '' }],
    memos: [{ id: 'memo1', title: '备忘', body: '内容', color: '#38C6F4' }],
    settings: { password: '0000', theme: 'dark', lastRollover: '' }
  };
  assert.equal(wb.normalizeImport(backup).tasks.length, 1);
});

test('global search finds tasks, memos, and apps across their fields', () => {
  const wb = loadWorkbench();
  wb.state.tasks = [{ id: 't1', title: '客户方案', project: '甲方', due: '2026-09-30', status: 'todo' }];
  wb.state.memos = [{ id: 'm1', title: '会议记录', group: '客户', body: '确认方案' }];
  wb.state.links = [{ id: 'a1', name: '方案文档', group: '工具', desc: '在线编辑', url: 'https://example.com' }];
  assert.deepEqual(Array.from(wb.searchRecords('方案'), x => x.type), ['task', 'memo', 'app']);
  assert.equal(wb.searchRecords('甲方')[0].id, 't1');
  assert.equal(wb.searchRecords('2026-09-30')[0].id, 't1');
});

test('global search filters tasks by status and exact due date', () => {
  const wb = loadWorkbench();
  wb.state.tasks = [
    { id: 'todo', title: '周报', due: '2026-09-30', status: 'todo' },
    { id: 'done', title: '周报', due: '2026-10-01', status: 'done' }
  ];
  wb.state.memos = [{ id: 'memo', title: '周报', body: '' }];
  assert.deepEqual(Array.from(wb.searchRecords('周报', 'task', 'todo', '2026-09-30'), x => x.id), ['todo']);
  assert.deepEqual(Array.from(wb.searchRecords('周报', 'memo'), x => x.id), ['memo']);
  assert.equal(wb.searchRecords('').length, 0);
});

test('search results escape imported text before rendering', () => {
  const wb = loadWorkbench();
  const html = wb.searchResultHTML({ type: 'memo', id: 'm1', title: '<img src=x onerror=alert(1)>', detail: '备注' }, 0);
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<img'));
});
