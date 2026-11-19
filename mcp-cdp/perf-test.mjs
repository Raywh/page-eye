// 性能测试：冷启动、各工具延迟、并发、长时间运行内存、大 DOM 页面
import { spawn, execSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const SERVER = new URL('./server.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function rssOf(pid) {
  try {
    const out = execSync(`tasklist /fi "PID eq ${pid}" /fo csv /nh`, { encoding: 'utf8' });
    const m = out.match(/"([\d,]+) K"/);
    return m ? Math.round(parseInt(m[1].replace(/,/g, ''), 10) / 1024) : null;
  } catch { return null; }
}

function makeClient() {
  const proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pend = new Map(); let i = 0;
  createInterface({ input: proc.stdout }).on('line', l => {
    let m; try { m = JSON.parse(l); } catch { return; }
    if (m.id && pend.has(m.id)) { const q = pend.get(m.id); pend.delete(m.id); m.error ? q.rej(m.error) : q.res(m.result); }
  });
  createInterface({ input: proc.stderr }).on('line', () => {});
  const rpc = (method, params) => { const id = ++i; proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); return new Promise((res, rej) => pend.set(id, { res, rej })); };
  const call = async (n, a = {}) => {
    const r = await rpc('tools/call', { name: n, arguments: a });
    const t = (r.content || []).map(c => c.text).join('');
    if (r.isError) return { __err: t };
    try { return JSON.parse(t); } catch { return t; }
  };
  return { proc, rpc, call };
}

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const stats = arr => ({ n: arr.length, min: Math.min(...arr), p50: pct(arr, 0.5), p95: pct(arr, 0.95), max: Math.max(...arr) });
const fmt = s => `p50 ${String(s.p50).padStart(5)}ms  p95 ${String(s.p95).padStart(5)}ms  max ${String(s.max).padStart(5)}ms`;

// ─────────────────────────────── 1. 冷启动
const t0 = Date.now();
const c = makeClient();
await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'perf', version: '0' } });
c.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
await c.rpc('ping', {});
const coldStart = Date.now() - t0;

const t1 = Date.now();
await c.call('page_overview');
const firstToolCall = Date.now() - t1;

console.log('=== 1. 冷启动 ===');
console.log(`  spawn → 首次 ping       : ${coldStart}ms`);
console.log(`  首次工具调用（含建链）  : ${firstToolCall}ms`);
console.log(`  服务进程 RSS            : ${rssOf(c.proc.pid)} MB`);

// ─────────────────────────────── 2. 各工具延迟（热态，各 12 次）
const tools = [
  ['page_overview', {}],
  ['element_style', { selector: 'button', properties: ['background'] }],
  ['element_style', { selector: '.no-such' }],
  ['console_logs', { limit: 10 }],
  ['network_list', { limit: 10 }],
  ['run_js', { expression: '1+1' }],
  ['a11y_tree', { limit: 20 }],
  ['perf_metrics', {}],
  ['frames', {}],
  ['resize', { width: 1280, height: 800 }],
  ['highlight', { selector: 'main' }],
  ['targets', {}]
];

console.log('\n=== 2. 工具延迟（热态）===');
const latency = {};
for (const [name, args] of tools) {
  const key = name + (args.selector ? `(${args.selector})` : '');
  const times = [];
  for (let k = 0; k < 12; k++) {
    const s = Date.now();
    await c.call(name, args);
    times.push(Date.now() - s);
  }
  latency[key] = stats(times.slice(1));   // 丢掉第一次
  console.log(`  ${key.padEnd(34)} ${fmt(latency[key])}`);
}
await c.call('highlight', { clear: true });

// ─────────────────────────────── 3. 并发
console.log('\n=== 3. 并发 10 个 run_js ===');
await c.call('recorder', { action: 'clear' });
let s3 = Date.now();
await Promise.all(Array.from({ length: 10 }, (_, i) => c.call('run_js', { expression: `${i}*2` })));
const seq10 = Date.now() - s3;
s3 = Date.now();
for (let i = 0; i < 10; i++) await c.call('run_js', { expression: `${i}*2` });
const one10 = Date.now() - s3;
console.log(`  10 并发  : ${seq10}ms`);
console.log(`  10 串行  : ${one10}ms`);

// ─────────────────────────────── 4. 长时间运行（300 次调用）看内存
console.log('\n=== 4. 300 次调用后的内存 ===');
const rssBefore = rssOf(c.proc.pid);
for (let i = 0; i < 300; i++) {
  await c.call(i % 3 === 0 ? 'page_overview' : i % 3 === 1 ? 'run_js' : 'console_logs', i % 3 === 1 ? { expression: `document.title` } : { limit: 5 });
}
const rssAfter = rssOf(c.proc.pid);
console.log(`  开始 RSS : ${rssBefore} MB`);
console.log(`  结束 RSS : ${rssAfter} MB`);
console.log(`  增长     : ${rssAfter - rssBefore} MB（300 次调用）`);

// ─────────────────────────────── 5. 大 DOM 页面
console.log('\n=== 5. 大 DOM 页面（注入 2000 个节点）===');
const s5 = Date.now();
await c.call('run_js', {
  expression: `(() => {
    const host = document.createElement('div');
    for (let i = 0; i < 2000; i++) {
      const d = document.createElement('div');
      d.className = 'heavy-item';
      d.innerHTML = '<span>item ' + i + '</span><i>i</i>';
      host.appendChild(d);
    }
    host.id = 'heavy';
    document.body.appendChild(host);
    return document.querySelectorAll('*').length;
  })()`
});
const buildMs = Date.now() - s5;

const measure = async (label, fn) => { const s = Date.now(); await fn(); return `${label} ${Date.now() - s}ms`; };
const big = [];
big.push(await measure('page_overview ', () => c.call('page_overview')));
big.push(await measure('snap .heavy-item', () => c.call('element_style', { selector: '.heavy-item' })));
big.push(await measure('a11y_tree     ', () => c.call('a11y_tree', { limit: 50 })));
big.push(await measure('resize 390    ', () => c.call('resize', { width: 390, height: 844 })));
big.push(await measure('screenshot    ', () => c.call('screenshot', {})));
console.log(`  构建 2000 节点: ${buildMs}ms`);
big.forEach(x => console.log('  ' + x));
await c.call('resize', { reset: true });
await c.call('run_js', { expression: `document.getElementById('heavy').remove(); 1` });

// ─────────────────────────────── 6. 与裸 CDP 对比
console.log('\n=== 6. 与裸 CDP 的往返开销对比 ===');
const list = await (await fetch(process.env.CDP_ENDPOINT + '/json/list')).json();
const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let wid = 0; const wp = new Map();
ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && wp.has(m.id)) { wp.get(m.id)(m); wp.delete(m.id); } });
const raw = (method, params = {}) => { const id = ++wid; ws.send(JSON.stringify({ id, method, params })); return new Promise(r => { wp.set(id, r); setTimeout(() => r({ error: 'timeout' }), 10000); }); };
const rawTimes = [];
for (let k = 0; k < 12; k++) { const s = Date.now(); await raw('Runtime.evaluate', { expression: '1+1', returnByValue: true }); rawTimes.push(Date.now() - s); }
console.log(`  裸 CDP evaluate       ${fmt(stats(rawTimes.slice(1)))}`);
console.log(`  经 MCP（run_js）      ${fmt(latency['run_js'])}`);
console.log(`  协议额外开销          ${latency['run_js'].p50 - stats(rawTimes.slice(1)).p50}ms（p50）`);
ws.close();

// ─────────────────────────────── 7. 大响应体落盘
console.log('\n=== 7. 大响应体处理 ===');
await c.call('recorder', { action: 'clear' });
await c.call('recorder', { action: 'reload', waitMs: 2500 });
await sleep(1200);
const net = await c.call('network_list', { limit: 50 });
const bigReq = (net.requests || []).find(r => (r.size || 0) > 8000);
if (bigReq) {
  const s = Date.now();
  const d = await c.call('network_get', { requestId: bigReq.requestId, waitBody: true });
  console.log(`  取 ${(bigReq.size / 1024).toFixed(0)}KB 响应体: ${Date.now() - s}ms，落盘=${!!d.bodyFile}`);
} else {
  console.log('  夹具里没有大响应体，跳过');
}

c.proc.kill();
