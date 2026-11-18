// 验证新增的 10 项能力：每项都真的调一次，检查返回与副作用
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, statSync } from 'node:fs';

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
  return new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej }); setTimeout(() => rej(new Error('timeout ' + method)), 40000); });
}
async function call(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  const t = (r.content || []).map(c => c.text).join('');
  if (r.isError) throw new Error(t);
  return JSON.parse(t);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const checks = [];
const record = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
async function step(name, fn) {
  try { const d = await fn(); record(name, true, d); }
  catch (e) { record(name, false, e.message); }
}

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'caps', version: '0' } });
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

// 0. 工具清单
const list = await rpc('tools/list', {});
record('工具总数为 19', list.tools.length === 19, list.tools.length);
const names = list.tools.map(t => t.name);
['net_conditions', 'a11y_tree', 'css_coverage', 'emulate_media', 'screenshot', 'net_mock', 'debugger_ctl', 'highlight', 'perf_metrics', 'frames']
  .forEach(n => record('新工具已注册: ' + n, names.includes(n), null));

// 1. 网络条件
await step('net_conditions 设置禁缓存+限速', async () => {
  const r = await call('net_conditions', { cacheDisabled: true, latencyMs: 120, downloadKbps: 500 });
  if (!r.state || r.state.latency !== 120 || r.state.cacheDisabled !== true) throw new Error(JSON.stringify(r));
  return `latency=${r.state.latency} cacheDisabled=${r.state.cacheDisabled}`;
});
await step('net_conditions 能 reset', async () => {
  const r = await call('net_conditions', { reset: true });
  if (r.state.latency !== 0 || r.state.cacheDisabled !== false) throw new Error(JSON.stringify(r));
  return 'reset 到默认';
});

// 2. 无障碍树
await step('a11y_tree 返回语义节点', async () => {
  const r = await call('a11y_tree', { roles: 'heading,link,button,paragraph', limit: 30 });
  if (!(r.totalNodes > 0)) throw new Error('totalNodes=0');
  const bad = (r.nodes || []).filter(n => !['heading', 'link', 'button', 'paragraph'].includes(n.role));
  if (bad.length) throw new Error('未按角色过滤');
  return `${r.totalNodes} 个节点，返回 ${r.returned} 个，前几个角色 ${r.roleHistogram.slice(0, 4).map(x => x[0]).join('/')}`;
});

// 3. CSS 覆盖率
await step('css_coverage 统计规则使用率', async () => {
  const r = await call('css_coverage', { reload: true, waitMs: 1800 });
  if (!(r.rules > 0)) throw new Error('规则数为 0');
  if (r.used + r.unused !== r.rules) throw new Error('used+unused 与总数不符');
  return `${r.rules} 条规则，用到 ${r.used}（未用 ${r.unusedPct}%）`;
});

// 4. 媒体模拟
await step('emulate_media 能切到深色', async () => {
  const r = await call('emulate_media', { scheme: 'dark' });
  if (!r.pageNow || r.pageNow.scheme !== 'dark') throw new Error(JSON.stringify(r.pageNow));
  await call('emulate_media', { reset: true });
  return `页面读到 scheme=dark，背景 ${r.pageNow.bodyBg}`;
});

// 5. 截图
await step('screenshot 落盘且文件存在', async () => {
  const r = await call('screenshot', { selector: 'main' });
  if (!r.path || !existsSync(r.path)) throw new Error('文件没生成: ' + r.path);
  const size = statSync(r.path).size;
  if (size < 500) throw new Error('文件太小: ' + size);
  return `${r.path}  ${size} 字节`;
});

// 6. mock
await step('net_mock 能伪造响应', async () => {
  await call('net_mock', { urlPattern: '/api/mock-me', status: 201, body: '{"mocked":true}' });
  const r = await call('run_js', { expression: `fetch('/api/mock-me').then(r => r.status + ':' + r.headers.get('content-type'))` });
  await call('net_mock', { clear: true });
  if (!String(r.value).startsWith('201')) throw new Error('实际返回 ' + r.value);
  return r.value;
});

// 7. 调试器
await step('debugger_ctl 能下断点并关闭', async () => {
  const b = await call('debugger_ctl', { action: 'break', urlRegex: 'fixture', lineNumber: 0 });
  if (!b.breakpointId) throw new Error('没有 breakpointId');
  await call('debugger_ctl', { action: 'off' });
  return 'breakpointId=' + b.breakpointId.slice(0, 12) + '…';
});

// 8. 高亮
await step('highlight 能高亮元素', async () => {
  const r = await call('highlight', { selector: 'main', color: '#00b3ff' });
  if (!r.ok || !r.nodeId) throw new Error(JSON.stringify(r));
  await call('highlight', { clear: true });
  return 'nodeId=' + r.nodeId;
});

// 9. 性能
await step('perf_metrics 返回指标', async () => {
  const r = await call('perf_metrics');
  if (!(r.metrics.Nodes > 0)) throw new Error(JSON.stringify(r.metrics));
  return `Nodes=${r.metrics.Nodes} LayoutCount=${r.metrics.LayoutCount} 堆 ${r.metrics.JSHeapUsedMB}MB`;
});

// 10. 帧
await step('frames 列出 frame', async () => {
  const r = await call('frames');
  if (!(r.frameCount >= 1)) throw new Error('frameCount=0');
  return `${r.frameCount} 个 frame，主 frame ${r.frames[0].url}`;
});

await sleep(200);
const failed = checks.filter(c => !c.pass);
console.log(JSON.stringify({
  summary: { total: checks.length, pass: checks.length - failed.length, fail: failed.length },
  failed,
  passed: checks.filter(c => c.pass).map(c => '  ✓ ' + c.name + (c.detail ? '  —  ' + c.detail : ''))
}, null, 2));

proc.kill();
process.exit(failed.length ? 1 : 0);
