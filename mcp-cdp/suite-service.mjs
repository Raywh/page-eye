// 全服务测例：协议层 + 20 个工具的正常路径与错误路径 + 生命周期
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const SERVER = new URL('./server.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- 极简 harness
const checks = [];
async function it(name, fn) {
  try { const d = await fn(); checks.push({ name, pass: true, detail: d }); }
  catch (e) { checks.push({ name, pass: false, detail: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, label) { if (a !== b) throw new Error(`${label || 'eq'}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }

// ---------------------------------------------------------------- 客户端
function makeClient() {
  const proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const notes = [];
  let idc = 0;
  createInterface({ input: proc.stdout }).on('line', line => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(m.error) : p.resolve(m.result);
    } else if (m.method) notes.push(m);
  });
  createInterface({ input: proc.stderr }).on('line', () => {});

  function raw(text) { proc.stdin.write(text + '\n'); }

  function rpc(method, params) {
    const id = ++idc;
    raw(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return new Promise((res, rej) => {
      pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
    });
  }

  async function call(name, args = {}) {
    const r = await rpc('tools/call', { name, arguments: args });
    const text = (r.content || []).map(c => c.text).join('');
    if (r.isError) { const e = new Error(text); e.toolError = true; throw e; }
    try { return JSON.parse(text); } catch { return text; }
  }

  return { proc, raw, rpc, call, notes };
}

const c = makeClient();

await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'suite', version: '0' } });
c.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }));

// ---------------------------------------------------------------- 协议层
await it('ping 返回空对象', async () => {
  const r = await c.rpc('ping', {});
  assert(r && typeof r === 'object' && Object.keys(r).length === 0, JSON.stringify(r));
});

await it('未知方法返回 -32601', async () => {
  try { await c.rpc('no/such/method', {}); throw new Error('竟然成功了'); }
  catch (e) { eq(e.code, -32601, 'error.code'); }
});

await it('坏 JSON 不搞崩服务，后续请求照常', async () => {
  c.raw('{ this is not json');
  await sleep(150);
  const r = await c.rpc('ping', {});
  assert(r && typeof r === 'object', 'ping 失败');
});

await it('调用不存在的工具返回 isError', async () => {
  try { await c.call('no_such_tool', {}); throw new Error('竟然成功了'); }
  catch (e) { assert(e.toolError, '应标记为工具错误'); assert(/未知工具/.test(e.message), e.message); }
});

await it('缺少必填参数返回 isError', async () => {
  try { await c.call('element_style', {}); throw new Error('竟然成功了'); }
  catch (e) { assert(e.toolError); assert(/selector/.test(e.message), e.message); }
});

// ---------------------------------------------------------------- 会话
await it('targets 列出标签并标出当前', async () => {
  const r = await c.call('targets');
  assert(r.targets.length >= 1, '没有标签');
  eq(r.targets.filter(t => t.selected).length, 1, 'selected 数量');
});

await it('use_target 指向不存在的标签时报错并给出候选', async () => {
  const r = await c.call('use_target', { id: 'not-a-real-id' });
  assert(r.error, '应返回 error');
  assert(Array.isArray(r.available) && r.available.length >= 1, '应给出 available');
});

await it('recorder status 返回缓冲大小', async () => {
  const r = await c.call('recorder', { action: 'status' });
  assert(typeof r.requests === 'number' && typeof r.logs === 'number', JSON.stringify(r));
});

await it('recorder clear 清空缓冲', async () => {
  await c.call('run_js', { expression: `console.log('before-clear')` });
  await sleep(200);
  await c.call('recorder', { action: 'clear' });
  const r = await c.call('recorder', { action: 'status' });
  eq(r.logs, 0, 'logs');
});

// ---------------------------------------------------------------- 页面与样式
await it('page_overview 返回结构完整', async () => {
  const r = await c.call('page_overview');
  assert(r.page && r.page.title, 'page.title');
  assert(typeof r.page.nodeCount === 'number', 'nodeCount');
  assert(r.captured && typeof r.captured.requests === 'number', 'captured');
});

await it('element_style 按标签取值', async () => {
  const r = await c.call('element_style', { selector: 'button', properties: ['background'] });
  assert(r.nodes && r.nodes.length >= 1, 'nodes 为空');
  assert(r.nodes[0].bg, '缺少 bg');
});

await it('element_style 裸名字自动解析成 .class', async () => {
  const r = await c.call('element_style', { selector: 'lead' });
  eq(r.selector, '.lead', 'selector');
});

await it('element_style 选择器没命中返回 error', async () => {
  const r = await c.call('element_style', { selector: '.definitely-not-here' });
  assert(r.error, '应返回 error');
});

await it('element_style properties 过滤生效', async () => {
  const r = await c.call('element_style', { selector: 'button', properties: ['background'] });
  const n = r.nodes[0];
  assert(n.bg, '缺少 bg');
  assert(!('shadow' in n) && !('padding' in n), '过滤没生效');
});

await it('a11y_tree 角色过滤生效', async () => {
  const r = await c.call('a11y_tree', { roles: 'button', limit: 20 });
  assert(r.totalNodes > 0, 'totalNodes');
  assert((r.nodes || []).every(n => n.role === 'button'), '出现非 button 角色');
});

await it('highlight 高亮后能清除', async () => {
  const a = await c.call('highlight', { selector: 'main' });
  assert(a.ok && a.nodeId, '高亮失败');
  const b = await c.call('highlight', { clear: true });
  assert(b.ok, '清除失败');
});

await it('highlight 缺 selector 报错', async () => {
  try { await c.call('highlight', {}); throw new Error('竟然成功了'); }
  catch (e) { assert(e.toolError && /selector/.test(e.message), e.message); }
});

await it('frames 至少有一个 frame', async () => {
  const r = await c.call('frames');
  assert(r.frameCount >= 1, 'frameCount');
  assert(r.frames[0].url.includes('8799'), r.frames[0].url);
});

await it('screenshot 落盘', async () => {
  const r = await c.call('screenshot', { selector: 'main' });
  assert(r.path && r.bytes > 500, JSON.stringify(r));
});

await it('screenshot 选不到元素时返回 error', async () => {
  const r = await c.call('screenshot', { selector: '.nope-xyz' });
  assert(r.error, '应返回 error');
});

// ---------------------------------------------------------------- 样式与媒体
await it('css_coverage 不重载也能统计', async () => {
  const r = await c.call('css_coverage', { reload: false });
  assert(r.rules > 0, 'rules=0');
  eq(r.used + r.unused, r.rules, 'used+unused');
});

await it('emulate_media 切深色后能读回', async () => {
  const r = await c.call('emulate_media', { scheme: 'dark' });
  eq(r.pageNow.scheme, 'dark', 'scheme');
  await c.call('emulate_media', { reset: true });
});

await it('emulate_media reset 后恢复', async () => {
  await c.call('emulate_media', { scheme: 'dark' });
  await c.call('emulate_media', { reset: true });
  const r = await c.call('run_js', { expression: `matchMedia('(prefers-color-scheme: dark)').matches` });
  eq(r.value, false, '仍处于 dark');
});

// ---------------------------------------------------------------- Console / JS
await it('run_js 返回普通值', async () => {
  const r = await c.call('run_js', { expression: '1 + 1' });
  eq(r.value, 2, 'value');
});

await it('run_js 里抛错不崩，返回 error', async () => {
  const r = await c.call('run_js', { expression: 'throw new Error("boom-in-js")' });
  assert(r.error, '应返回 error');
});

await it('console_logs 能按级别过滤', async () => {
  await c.call('run_js', { expression: `console.warn('suite-warn'); console.log('suite-log')` });
  await sleep(200);
  const r = await c.call('console_logs', { level: 'warn', contains: 'suite-' });
  assert(r.logs.length >= 1, '没抓到 warn');
  assert(r.logs.every(l => l.level === 'warn'), '过滤没生效');
});

await it('console_logs 无匹配时返回空数组而不是报错', async () => {
  const r = await c.call('console_logs', { contains: 'zzz-not-there-zzz' });
  eq(r.returned, 0, 'returned');
});

// ---------------------------------------------------------------- 网络
await it('recorder reload 能抓到请求', async () => {
  await c.call('recorder', { action: 'reload', waitMs: 2000 });
  await sleep(1200);
  const r = await c.call('network_list', { limit: 20 });
  assert(r.total >= 1, 'total=0');
});

await it('network_list 按状态码过滤', async () => {
  const r = await c.call('network_list', { status: 200, limit: 20 });
  assert(r.returned >= 1, '没有 200');
  assert(r.requests.every(x => x.status === 200), '混入其它状态码');
});

await it('network_get 能取到响应体', async () => {
  const list = await c.call('network_list', { url: '/api/items' });
  assert(list.returned >= 1, '没找到 /api/items');
  const d = await c.call('network_get', { requestId: list.requests[0].requestId, waitBody: true });
  assert(String(d.body || '').includes('"n":42'), d.body);
});

await it('network_get 不存在的 id 返回 error', async () => {
  const r = await c.call('network_get', { requestId: 'nope.0' });
  assert(r.error, '应返回 error');
});

await it('net_conditions 设置与重置', async () => {
  const a = await c.call('net_conditions', { cacheDisabled: true, latencyMs: 80 });
  eq(a.state.latency, 80, 'latency');
  const b = await c.call('net_conditions', { reset: true });
  eq(b.state.latency, 0, 'reset latency');
});

await it('net_mock 伪造响应后能清除', async () => {
  await c.call('net_mock', { urlPattern: '/api/suite-mock', status: 418, body: '{"teapot":true}' });
  const r = await c.call('run_js', { expression: `fetch('/api/suite-mock').then(r => r.status)` });
  await c.call('net_mock', { clear: true });
  eq(r.value, 418, 'status');
});

await it('net_mock 缺 urlPattern 报错', async () => {
  try { await c.call('net_mock', {}); throw new Error('竟然成功了'); }
  catch (e) { assert(e.toolError && /urlPattern/.test(e.message), e.message); }
});

await it('net_mock 非法正则报错而不是崩', async () => {
  try { await c.call('net_mock', { urlPattern: '([' }); throw new Error('竟然成功了'); }
  catch (e) { assert(e.toolError, e.message); }
});

// ---------------------------------------------------------------- 调试 / 性能
await it('debugger_ctl 下断点与关闭', async () => {
  const b = await c.call('debugger_ctl', { action: 'break', urlRegex: 'fixture', lineNumber: 0 });
  assert(b.breakpointId, 'breakpointId');
  const off = await c.call('debugger_ctl', { action: 'off' });
  assert(off.ok, 'off');
});

await it('debugger_ctl 非法 action 返回 error', async () => {
  const r = await c.call('debugger_ctl', { action: 'nonsense' });
  assert(r.error, '应返回 error');
});

await it('perf_metrics 返回数值指标', async () => {
  const r = await c.call('perf_metrics');
  assert(r.metrics && r.metrics.Nodes > 0, JSON.stringify(r.metrics));
  assert(typeof r.metrics.LayoutCount === 'number', 'LayoutCount');
});

// ---------------------------------------------------------------- 视口
await it('resize 缺尺寸时报 isError', async () => {
  try { await c.call('resize', {}); throw new Error('竟然成功了'); }
  catch (e) { assert(e.toolError && /width/.test(e.message), e.message); }
});

await it('resize 设置后能读回并恢复', async () => {
  const a = await c.call('resize', { width: 480, height: 900 });
  assert(String(a.viewport).startsWith('480x'), a.viewport);
  const b = await c.call('resize', { reset: true });
  assert(b.ok, 'reset');
});

// ---------------------------------------------------------------- 交互
await it('interact 缺 action 报 isError', async () => {
  try { await c.call('interact', {}); throw new Error('竟然成功了'); }
  catch (e) { assert(e.toolError && /action/.test(e.message), e.message); }
});

await it('interact 非法 action 报 isError', async () => {
  try { await c.call('interact', { action: 'drag' }); throw new Error('竟然成功了'); }
  catch (e) { assert(e.toolError, e.message); }
});

await it('interact 选不到元素时返回 error', async () => {
  const r = await c.call('interact', { action: 'click', selector: '.not-here-xyz' });
  assert(r.error, '应返回 error');
});

// ---------------------------------------------------------------- 并发与生命周期
await it('并行 6 个调用全部成功', async () => {
  const rs = await Promise.all(Array.from({ length: 6 }, (_, i) =>
    c.call('run_js', { expression: `${i} * 2` }).catch(e => ({ error: String(e) }))
  ));
  eq(rs.filter(r => !r.error).length, 6, '成功数');
});

await it('parallel 调用后 ping 仍然正常', async () => {
  const r = await c.rpc('ping', {});
  assert(r && typeof r === 'object', 'ping 失败');
});

// 独立实例：验证宿主关闭 stdin 后进程会退出（清理 CDP 连接）
await it('stdin 关闭后进程在 3 秒内退出', async () => {
  const p = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  createInterface({ input: p.stderr }).on('line', () => {});
  const exited = new Promise(res => p.on('exit', code => res(code)));
  await sleep(600);
  p.stdin.end();
  const code = await Promise.race([exited, sleep(3000).then(() => 'timeout')]);
  if (code === 'timeout') { p.kill(); throw new Error('3 秒内没退出'); }
  return 'exit code ' + code;
});

// ---------------------------------------------------------------- 输出
const failed = checks.filter(x => !x.pass);
const summary = { total: checks.length, pass: checks.length - failed.length, fail: failed.length };
console.log(JSON.stringify({ summary, failed }, null, 2));
console.log('RESULT ' + JSON.stringify({ suite: 'service', ...summary }));

c.proc.kill();
process.exit(failed.length ? 1 : 0);
