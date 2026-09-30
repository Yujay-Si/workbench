// 手动启动桌面程序并开启 CDP 后运行：node tests/smoke-desktop.cjs [probe|set|get]
const assert = require('node:assert/strict');

async function evaluate(expression) {
  let page;
  for (let attempt = 0; attempt < 20 && !page; attempt++) {
    const pages = await (await fetch('http://127.0.0.1:9323/json')).json();
    page = pages.find((item) => item.type === 'page' && item.url === 'nexus://app/nexus-workbench.html');
    if (!page) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(page, 'desktop page is not loaded at its stable origin');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const value = await new Promise((resolve, reject) => {
    socket.addEventListener('message', (event) => {
      const result = JSON.parse(event.data);
      if (result.id !== 1) return;
      if (result.result.exceptionDetails) reject(new Error(result.result.exceptionDetails.text));
      else resolve(result.result.result.value);
    });
    socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true }
    }));
  });
  socket.close();
  return value;
}

const mode = process.argv[2] || 'probe';
const expressions = {
  'auth-probe': `(async () => ({
    title: document.title,
    origin: location.origin,
    gateVisible: getComputedStyle(document.getElementById('accountGate')).display !== 'none',
    server: await window.nexusDesktop.accountServerInfo(),
    session: await window.nexusDesktop.accountSession(),
    version: (await window.nexusDesktop.info()).version
  }))()`,
  probe: `(async () => { if (document.readyState !== 'complete') await new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
    if (document.getElementById('updateDetails').classList.contains('hidden')) document.getElementById('btnUpdatePanel').click();
    return ({ title: document.title, origin: location.origin,
    bodyBackground: getComputedStyle(document.body).backgroundImage,
    styleSheets: document.styleSheets.length,
    bodyChildren: document.body.children.length,
    bodyRect: [document.body.getBoundingClientRect().width, document.body.getBoundingClientRect().height],
    updateVisible: !document.getElementById('desktopUpdate').classList.contains('hidden'),
    updateDetailsVisible: !document.getElementById('updateDetails').classList.contains('hidden'),
    version: (await window.nexusDesktop.info()).version,
    mode: (await window.nexusDesktop.info()).mode,
    feedUrl: (await window.nexusDesktop.info()).feedUrl,
    dataDir: (await window.nexusDesktop.info()).dataDir,
    appLoaded: !!document.getElementById('btnExport'),
    appNames: Array.from(document.querySelectorAll('#appGrid .app-meta b'), el => el.textContent),
    quickActions: Array.from(document.querySelectorAll('#quickBar .qitem'), el => el.getAttribute('data-act')),
    invalidAppRejected: await window.nexusDesktop.openLocalApp('invalid').then(() => false, () => true) }); })()`,
  set: `localStorage.setItem('nexus_smoke_marker', 'kept-across-launches'); localStorage.getItem('nexus_smoke_marker')`,
  get: `localStorage.getItem('nexus_smoke_marker')`,
  clear: `localStorage.removeItem('nexus_smoke_marker'); localStorage.getItem('nexus_smoke_marker')`,
  'launch-qq': `window.nexusDesktop.openLocalApp('qq')`
};

if (!expressions[mode]) throw new Error('Use probe, set, get, clear, or launch-qq');
evaluate(expressions[mode]).then((value) => {
  if (mode === 'auth-probe') {
    assert.equal(value.origin, 'nexus://app');
    assert.equal(value.gateVisible, true);
    assert.equal(value.server.url, 'http://127.0.0.1:8768');
    assert.equal(value.session.account, null);
    assert.equal(value.version, '1.2.0');
  } else if (mode === 'probe') {
    assert.equal(value.origin, 'nexus://app');
    assert.equal(value.updateVisible, true);
    assert.equal(value.updateDetailsVisible, true);
    assert.equal(value.appLoaded, true);
    assert.ok(['微信', 'QQ', 'WPS 云文档', 'WorkBuddy'].every(name => value.appNames.includes(name)));
    assert.ok(!value.appNames.includes('Notion'));
    assert.ok(value.quickActions.length >= 4 && value.quickActions.slice(0, 4).every(action => action === 'app-launch'));
    assert.equal(value.invalidAppRejected, true, JSON.stringify(value));
    assert.equal(value.version, process.env.EXPECTED_VERSION || '1.1.0');
    assert.equal(value.mode, process.env.EXPECTED_MODE || 'portable');
    assert.match(value.feedUrl, /^https:\/\//);
  } else if (mode === 'launch-qq') {
    assert.equal(value.status, 'opened');
  } else if (mode === 'clear') {
    assert.equal(value, null);
  } else {
    assert.equal(value, 'kept-across-launches');
  }
  console.log(JSON.stringify(value));
}).catch((error) => { console.error(error); process.exitCode = 1; });
