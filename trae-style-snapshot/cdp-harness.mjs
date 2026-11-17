// 用 Chrome DevTools Protocol 打开页面并取回 #RESULT 里的 JSON
const CDP = 'http://127.0.0.1:9333';
const TARGET_URL = process.argv[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitReady() {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(CDP + '/json/version');
      if (r.ok) return await r.json();
    } catch {}
    await sleep(200);
  }
  throw new Error('CDP 没有起来');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const mid = ++id;
        ws.send(JSON.stringify({ id: mid, method, params }));
        return new Promise((res, rej) => pending.set(mid, { res, rej }));
      },
      close() { try { ws.close(); } catch {} }
    }));
    ws.addEventListener('error', e => reject(new Error('ws error')));
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    });
  });
}

const version = await waitReady();
console.log('browser:', version.Browser);

// Chrome 新版本要求 PUT
let target;
try {
  target = await (await fetch(CDP + '/json/new?' + encodeURIComponent(TARGET_URL), { method: 'PUT' })).json();
} catch {
  target = await (await fetch(CDP + '/json/new?' + encodeURIComponent(TARGET_URL))).json();
}

const client = await connect(target.webSocketDebuggerUrl);
await client.send('Runtime.enable');
await client.send('Page.enable');

let result = null;
for (let i = 0; i < 80; i++) {
  await sleep(250);
  const r = await client.send('Runtime.evaluate', {
    expression: "document.getElementById('RESULT')?.textContent || null",
    returnByValue: true
  });
  const val = r.result && r.result.value;
  if (val) { result = val; break; }
}

client.close();

if (!result) {
  console.log('NO_RESULT');
  process.exit(1);
}
console.log(result);
