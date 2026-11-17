// 冒烟自检：对着正在运行的 Chrome 走一遍 MCP，确认链路通
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

try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  console.log('① 握手成功：', init.serverInfo.name, init.serverInfo.version);

  const tools = await rpc('tools/list', {});
  console.log('② 工具清单：', tools.tools.map(t => t.name).join(', '));

  const tg = await call('targets');
  console.log('③ 可调试标签：');
  tg.targets.forEach(t => console.log(`   ${t.selected ? '▶' : ' '} [${t.index}] ${t.title || '(无标题)'} — ${t.url.slice(0, 70)}`));

  const title = await call('run_js', { expression: 'document.title || "(空标题)"' });
  const href = await call('run_js', { expression: 'location.href' });
  console.log('④ 读取页面：', title.value, '|', href.value);

  const ov = await call('page_overview');
  console.log('⑤ page_overview：节点数', ov.page.nodeCount, '/ 已捕获请求', ov.captured.requests, '/ 日志', ov.captured.logs);

  console.log('\n✅ 链路正常，可以接进 TRAE 了');
} catch (e) {
  console.error('\n❌ 冒烟失败：', e.message);
  process.exitCode = 1;
} finally {
  proc.kill();
}
