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
  probe: `(async () => { if (document.readyState !== 'complete') await new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
    document.getElementById('btnUpdatePanel').click(); return ({ title: document.title, origin: location.origin,
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
    appLoaded: !!document.getElementById('btnExport') }); })()`,
  set: `localStorage.setItem('nexus_smoke_marker', 'kept-across-launches'); localStorage.getItem('nexus_smoke_marker')`,
  get: `localStorage.getItem('nexus_smoke_marker')`,
  clear: `localStorage.removeItem('nexus_smoke_marker'); localStorage.getItem('nexus_smoke_marker')`
};

if (!expressions[mode]) throw new Error('Use probe, set, get, or clear');
evaluate(expressions[mode]).then((value) => {
  if (mode === 'probe') {
    assert.equal(value.origin, 'nexus://app');
    assert.equal(value.updateVisible, true);
    assert.equal(value.updateDetailsVisible, true);
    assert.equal(value.appLoaded, true);
    assert.equal(value.version, process.env.EXPECTED_VERSION || '1.1.0');
    assert.equal(value.mode, process.env.EXPECTED_MODE || 'portable');
    assert.match(value.feedUrl, /^https:\/\//);
  } else if (mode === 'clear') {
    assert.equal(value, null);
  } else {
    assert.equal(value, 'kept-across-launches');
  }
  console.log(JSON.stringify(value));
}).catch((error) => { console.error(error); process.exitCode = 1; });
