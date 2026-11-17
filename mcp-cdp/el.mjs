// el.mjs <selector> —— 查某个元素的渲染样式
// 复用已经验证过的 style-snapshot.js（含 CSS 变量溯源），通过 MCP 的 run_js 注入
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';

const SS = readFileSync(new URL('../trae-style-snapshot/style-snapshot.js', import.meta.url), 'utf8')
  .replace(/^.*console\.log\('\[style-snapshot\].*$/m, '');   // 去掉初始化日志，别污染页面 console

const SERVER = new URL('./server.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let idc = 0;
createInterface({ input: proc.stdout }).on('line', line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
});
createInterface({ input: proc.stderr }).on('line', () => {});
function rpc(method, params) {
  const id = ++idc;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej }); setTimeout(() => rej(new Error('timeout')), 25000); });
}
async function call(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  const t = (r.content || []).map(c => c.text).join('');
  if (r.isError) throw new Error(t);
  return JSON.parse(t);
}

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'el', version: '0' } });
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

const selector = process.argv[2] || 'body';

async function probe(sel) {
  const r = await call('run_js', { expression: SS + '\n;snapAll(' + JSON.stringify(sel) + ', {max: 6});' });
  return r.value && r.value.error ? r.value : r.value;
}

let out = await probe(selector);

// 精确选择器没命中就放宽一点，别直接报错
if (out && out.error) {
  const loose = selector.replace(/[.#]/g, '');
  const r2 = await call('run_js', { expression: SS + '\n;snapAll(\'[class*="' + loose + '" i], [id*="' + loose + '" i]\', {max: 6});' });
  if (!r2.value.error) {
    console.log(`⚠ 精确选择器 "${selector}" 没命中，以下是类名/ID 含 "${loose}" 的元素：\n`);
    out = r2.value;
  }
}

console.log(JSON.stringify(out, null, 2));
proc.kill();
