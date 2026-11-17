// 直接用 CDP 调 CSS.getMatchedStylesForNode，看协议到底返回什么字段
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
    ws.addEventListener('error', () => reject(new Error('ws error')));
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
let target;
try {
  target = await (await fetch(CDP + '/json/new?' + encodeURIComponent(TARGET_URL), { method: 'PUT' })).json();
} catch {
  target = await (await fetch(CDP + '/json/new?' + encodeURIComponent(TARGET_URL))).json();
}

const c = await connect(target.webSocketDebuggerUrl);
await c.send('DOM.enable');
await c.send('CSS.enable');
await c.send('Page.enable');
await sleep(600);

const doc = await c.send('DOM.getDocument', { depth: -1 });
const q = await c.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#card-a' });
const matched = await c.send('CSS.getMatchedStylesForNode', { nodeId: q.nodeId });

const raw = JSON.stringify(matched);
const out = {
  browser: version.Browser,
  topLevelKeys: Object.keys(matched),
  hasAppliedField: raw.includes('"applied"'),
  hasDistanceField: raw.includes('"distance"'),
  matchedRuleCount: (matched.matchedCSSRules || []).length,
  pseudoElementCount: (matched.pseudoElements || []).length,
  inheritedCount: (matched.inherited || []).length,
  firstMatchedRuleKeys: matched.matchedCSSRules ? Object.keys(matched.matchedCSSRules[0]) : null,
  styleKeys: matched.matchedCSSRules ? Object.keys(matched.matchedCSSRules[0].rule.style) : null,
  cssPropertyKeys: matched.matchedCSSRules ? Object.keys(matched.matchedCSSRules[0].rule.style.cssProperties[0]) : null,
  cssPropertySample: matched.matchedCSSRules ? matched.matchedCSSRules[0].rule.style.cssProperties[0] : null,
  matchingSelectorsType: matched.matchedCSSRules
    ? { value: matched.matchedCSSRules[0].matchingSelectors, typeof: typeof matched.matchedCSSRules[0].matchingSelectors }
    : null,
  selectorListSample: matched.matchedCSSRules ? matched.matchedCSSRules[0].rule.selectorList : null,
  inheritedKeys: matched.inherited && matched.inherited[0] ? Object.keys(matched.inherited[0]) : null
};

c.close();
console.log(JSON.stringify(out, null, 2));
