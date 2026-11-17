// 完整首屏采集：reload 后统计请求、体积、慢请求、失败、console 错误
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
createInterface({ input: proc.stderr }).on('line', () => {});
function rpc(method, params) {
  const id = ++idc;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej }); setTimeout(() => rej(new Error('timeout ' + method)), 30000); });
}
async function call(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  const t = (r.content || []).map(c => c.text).join('');
  if (r.isError) throw new Error(t);
  return JSON.parse(t);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cap', version: '0' } });
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

const nocache = process.argv.includes('--nocache');
await call('recorder', { action: 'reload', waitMs: nocache ? 6000 : 3000, ignoreCache: nocache });
await sleep(nocache ? 6000 : 2500);
console.log(nocache ? '（已禁用缓存重载）' : '（普通重载，可能命中缓存）');

const all = await call('network_list', { limit: 200 });
const reqs = all.requests;

const bytes = reqs.reduce((s, r) => s + (r.size || 0), 0);
const cached = reqs.filter(r => r.fromCache).length;
const byMime = {};
reqs.forEach(r => { const k = (r.mimeType || 'unknown').split(';')[0]; byMime[k] = (byMime[k] || 0) + (r.size || 0); });
const slow = [...reqs].filter(r => r.ms).sort((a, b) => b.ms - a.ms).slice(0, 6);
const bad = reqs.filter(r => r.failed || (r.status && r.status >= 400));
const external = reqs.filter(r => !r.url.includes('localhost:8000'));

console.log('=== 首屏采集 ===');
console.log('请求数 :', reqs.length, '| 解码后总大小 :', (bytes / 1024).toFixed(1) + ' KB',
  '| 其中缓存命中 :', cached, '个（这部分的 size 不代表网络传输）');
console.log('按类型 :', Object.entries(byMime).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k} ${(v / 1024).toFixed(1)}KB`).join(' | '));

console.log('\n=== 最慢的 6 个 ===');
slow.forEach(r => console.log(`  ${String(r.ms).padStart(5)}ms  ${String(r.status).padStart(3)}  ${(r.size / 1024 || 0).toFixed(1).padStart(6)}KB  ${r.url.replace('http://localhost:8000', '')}`));

console.log('\n=== 失败 / 4xx+5xx ===');
if (!bad.length) console.log('  无');
bad.forEach(r => console.log(`  ${r.status || 'FAIL'}  ${r.errorText || ''}  ${r.url}`));

console.log('\n=== 外部域名请求 ===');
if (!external.length) console.log('  无');
external.forEach(r => console.log(`  ${String(r.ms || 0).padStart(5)}ms  ${r.status || 'FAIL'}  ${r.url.slice(0, 90)}`));

const logs = await call('console_logs', { level: 'error,exception,warn', limit: 20 });
console.log('\n=== console 错误 / 警告 ===');
if (!logs.logs.length) console.log('  无');
logs.logs.forEach(l => console.log(`  [${l.level}] ${l.text.slice(0, 130)}`));

const ov = await call('page_overview');
console.log('\n=== 页面自报的体积（仅供参考，以请求明细为准）===');
console.log(' ', ov.pagePerf || '拿不到');

proc.kill();
