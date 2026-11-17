// style.mjs <selector> [属性过滤...] —— 直接调 MCP 的 element_style 工具
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

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

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'style', version: '0' } });
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

const selector = process.argv[2] || 'body';
const props = process.argv.slice(3);

const out = await call('element_style', props.length ? { selector, properties: props } : { selector });
console.log(JSON.stringify(out, null, 2));
proc.kill();
