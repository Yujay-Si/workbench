const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const pages = await (await fetch('http://127.0.0.1:9323/json')).json();
  const page = pages.find((x) => x.type === 'page' && x.url === 'nexus://app/nexus-workbench.html');
  if (!page) throw new Error('NEXUS page not found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const result = await new Promise((resolve, reject) => {
    ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data);
      if (data.id !== 1) return;
      if (data.error) reject(new Error(data.error.message));
      else resolve(data.result.data);
    });
    ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png', captureBeyondViewport: false } }));
  });
  ws.close();
  const target = path.join(__dirname, '..', 'screenshots', 'desktop-diagnostic.png');
  fs.writeFileSync(target, Buffer.from(result, 'base64'));
  console.log(target);
})().catch((error) => { console.error(error); process.exitCode = 1; });
