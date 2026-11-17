// 在真实页面上验证三条捕获通路，且不 reload、不破坏页面状态
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const SERVER = new URL('./server.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });

const pending = new Map();
let idc = 0;
createInterface({ input: proc.stdout }).on('line', line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
});
createInterface({ input: proc.stderr }).on('line', l => console.error('  [server]', l));

function rpc(method, params) {
  const id = ++idc;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((res, rej) => {
    pending.set(id, { resolve: res, reject: rej });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('超时 ' + method)); } }, 20000);
  });
}
async function call(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  const t = (r.content || []).map(c => c.text).join('');
  if (r.isError) throw new Error(t);
  return JSON.parse(t);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'demo', version: '0' } });
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

// ---- 通路 1：网络。发一个同源请求，看能不能抓到并读到 body
console.log('【1】网络捕获');
await call('run_js', { expression: `fetch('/').then(r => r.status)` });
await sleep(600);
const list = await call('network_list', { limit: 5 });
const first = list.requests[0];
console.log('   抓到：', first.method, first.url, '→', first.status, first.mimeType, first.size + 'B', first.ms + 'ms');
const detail = await call('network_get', { requestId: first.requestId, waitBody: true });
console.log('   响应头：', Object.entries(detail.responseHeaders || {}).slice(0, 3).map(([k, v]) => k + ': ' + v).join(' | '));
if (detail.bodyFile) {
  console.log('   响应体：落盘', detail.bodySize, '字符 →', detail.bodyFile);
  console.log('   预览  ：', String(detail.bodyPreview || '').replace(/\s+/g, ' ').slice(0, 120) + '…');
} else {
  console.log('   响应体：', String(detail.body || detail.bodyOmitted || '').replace(/\s+/g, ' ').slice(0, 160) + '…');
}

// ---- 通路 2：console。注入一条带标记的测试日志
console.log('\n【2】console 捕获');
await call('run_js', { expression: `console.warn('【MCP 自检】这条是注入的测试日志'); 'ok'` });
await sleep(300);
const logs = await call('console_logs', { level: 'warn', contains: 'MCP 自检' });
console.log('   抓到：', logs.logs.map(l => `${l.level} | ${l.text}`).join('\n          '));

// ---- 通路 3：执行与读回
console.log('\n【3】执行并读回');
const probe = await call('run_js', {
  expression: `(() => {
    const imgs = [...document.images];
    const noAlt = imgs.filter(i => !i.alt).length;
    const h = [...document.querySelectorAll('h1')];
    const overflowX = document.documentElement.scrollWidth > document.documentElement.clientWidth;
    return {
      视口: innerWidth + 'x' + innerHeight,
      图片总数: imgs.length,
      缺alt: noAlt,
      h1数量: h.length,
      页面横向溢出: overflowX,
      滚动高度: document.documentElement.scrollHeight,
      字体: getComputedStyle(document.body).fontFamily.split(',')[0],
      背景: getComputedStyle(document.body).backgroundColor
    };
  })()`});
console.log('   读到：', probe.value);

const ov = await call('page_overview');
console.log('\n【4】总览');
console.log('   DOM 节点', ov.page.nodeCount, '| 文本', ov.page.textLength, '字符 | 主要区块', (ov.page.landmarks || []).join(', '));

proc.kill();
