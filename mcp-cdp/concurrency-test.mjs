// 并发测试：N 个并行工具调用，应该只建立 1 条 CDP 连接，且不重复记录事件
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const SERVER = new URL('./server.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const N = Number(process.env.N || 5);

const proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let idc = 0;
const stderrLines = [];

createInterface({ input: proc.stdout }).on('line', line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
});
createInterface({ input: proc.stderr }).on('line', l => stderrLines.push(l));

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

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'conc', version: '0' } });
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

// 冷启动就并发：先不做任何工具调用，第一条消息就是 5 个并行 run_js
// —— 竞态只在 currentConn 还为空时出现
const t0 = Date.now();
const results = await Promise.all(
  Array.from({ length: N }, (_, i) =>
    call('run_js', { expression: `console.log('marker-${i}'); ${i}` }).catch(e => ({ error: String(e) }))
  )
);
const elapsed = Date.now() - t0;
await sleep(700);

const logs = await call('console_logs', { contains: 'marker-', limit: 200 });
const markers = logs.logs.filter(l => l.text.includes('marker-'));
const connects = stderrLines.filter(l => l.includes('已连接')).length;
const okResults = results.filter(r => r && !r.error).length;

const checks = [
  { name: `${N} 个并行调用全部成功`, pass: okResults === N, detail: `${okResults}/${N}` },
  { name: '只建立 1 条 CDP 连接', pass: connects === 1, detail: `实际 ${connects} 条` },
  { name: `console 事件不重复（应有 ${N} 条）`, pass: markers.length === N, detail: `实际 ${markers.length} 条` }
];

const failed = checks.filter(c => !c.pass);
console.log(JSON.stringify({
  summary: { total: checks.length, pass: checks.length - failed.length, fail: failed.length },
  elapsedMs: elapsed,
  errsSeen: stderrLines.filter(l => /error|unhandled|uncaught/i.test(l)).slice(0, 3),
  checks
}, null, 2));

console.log('RESULT ' + JSON.stringify({ suite: 'concurrency', ...{ total: checks.length, pass: checks.length - failed.length, fail: failed.length } }));

proc.kill();
process.exit(failed.length ? 1 : 0);
