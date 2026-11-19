// 验证新增的 10 项能力：每项都真的调一次，检查返回与副作用
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, statSync, readFileSync } from 'node:fs';

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
// 读 PNG 的 IHDR 尺寸，用来验证 fullPage 是否真的截了整页
function readPngSize(file) {
  try {
    const b = readFileSync(file);
    if (b.length < 24) return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } catch { return null; }
}

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
record('工具总数为 22', list.tools.length === 22, list.tools.length);
const names = list.tools.map(t => t.name);
['net_conditions', 'a11y_tree', 'css_coverage', 'emulate_media', 'screenshot', 'net_mock', 'debugger_ctl', 'highlight', 'perf_metrics', 'frames', 'resize', 'navigate', 'interact']
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
  if (r.used <= 0) throw new Error('重载后一条规则都没统计到（used=0 说明采集时机不对）');
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
  if (typeof b.locations !== 'number') throw new Error('没有返回 locations，无法判断断点是否真落地');
  const ex = await call('debugger_ctl', { action: 'exceptions', state: 'uncaught' });
  if (!ex.ok || ex.pauseOnExceptions !== 'uncaught') throw new Error('exceptions 未生效: ' + JSON.stringify(ex));
  await call('debugger_ctl', { action: 'off' });
  return 'breakpoint 命中脚本 ' + b.locations + ' 处，exceptions 往返正常';
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

// 11. 视口
await step('resize 改到 390 宽并体检布局', async () => {
  await call('resize', { width: 390, height: 844, mobile: true, reload: true, waitMs: 1200 });
  const r = await call('resize', { width: 390, height: 844, mobile: true });
  if (r.applied.width !== 390) throw new Error('applied.width=' + r.applied.width);
  if (typeof r.horizontalOverflow !== 'boolean') throw new Error('缺少 horizontalOverflow');
  // 夹具没有 viewport meta，布局视口会回退到 980 —— 工具应当解释这件事
  if (!r.note) throw new Error('视口与请求不一致时缺少解释 note');
  return `请求 390，布局 ${r.viewport}（已给出 note），溢出 ${r.overflowPx}px`;
});

await step('resize reset 恢复默认视口', async () => {
  const r = await call('resize', { reset: true });
  if (!r.ok) throw new Error(JSON.stringify(r));
  const v = await call('run_js', { expression: 'innerWidth' });
  if (!(v.value > 1000)) throw new Error('恢复后宽度 ' + v.value);
  return '恢复为 ' + v.value + 'px';
});

// 12. 导航
await step('navigate 能打开站内路径并回来', async () => {
  const a = await call('navigate', { url: '/', settleMs: 300 });
  if (!a.ok || !String(a.final || '').endsWith('/')) throw new Error('首页导航失败: ' + JSON.stringify(a));
  const b = await call('navigate', { url: '/api/items' });
  if (!b.ok) throw new Error('站内路径导航失败: ' + JSON.stringify(b));
  await call('navigate', { url: '/', settleMs: 600 });
  return '跳到 /api/items 再回首页，标题 ' + (await call('run_js', { expression: 'document.title' })).value;
});

await step('navigate 非法 URL 返回 error 不崩', async () => {
  const r = await call('navigate', { url: 'http://127.0.0.1:1/' });
  if (!r.error && r.ok) throw new Error('竟然成功了');
  await call('navigate', { url: '/', settleMs: 600 });
  return r.error ? 'error: ' + String(r.error).slice(0, 60) : '已回到首页';
});

// 13. 交互
await step('interact fill 能触发输入绑定', async () => {
  const r = await call('interact', { action: 'fill', selector: '#kw', value: '闭包', settleMs: 300 });
  if (!r.ok) throw new Error(JSON.stringify(r));
  const echo = await call('run_js', { expression: `document.getElementById('echo').textContent` });
  if (echo.value !== 'kw=闭包') throw new Error('echo=' + echo.value);
  return 'echo 变为 ' + echo.value;
});

await step('interact click 能触发事件', async () => {
  await call('recorder', { action: 'clear' });
  const r = await call('interact', { action: 'click', selector: '#btn-a', settleMs: 400 });
  if (!r.ok) { const u = await call('run_js', { expression: 'location.href' }); throw new Error(JSON.stringify(r) + ' @ ' + u.value); }
  const logs = await call('console_logs', { contains: 'btn-a clicked' });
  if (!logs.logs.length) throw new Error('点击后没有 console');
  return '点击后新增日志 ' + r.changed.logs + ' 条';
});

await step('interact scroll 能滚到底', async () => {
  const r = await call('interact', { action: 'scroll', to: 'bottom', steps: 6, waitMs: 150 });
  if (!r.ok || r.scrolled !== 'bottom') throw new Error(JSON.stringify(r));
  return `滚了 ${r.steps} 步，高度 ${r.heightBefore} → ${r.heightAfter}`;
});

await step('interact 能按文字点击', async () => {
  await call('recorder', { action: 'clear' });
  const r = await call('interact', { action: 'click', text: '点我', settleMs: 400 });
  if (!r.ok || r.clicked !== 'button') throw new Error(JSON.stringify(r));
  const logs = await call('console_logs', { contains: 'btn-a clicked' });
  if (!logs.logs.length) throw new Error('按文字点击没触发');
  return '点到「' + r.label + '」';
});

await step('interact 能按 placeholder 填表', async () => {
  const r = await call('interact', { action: 'fill', placeholder: '搜索题目', value: '事件循环', settleMs: 300 });
  if (!r.ok) throw new Error(JSON.stringify(r));
  const echo = await call('run_js', { expression: `document.getElementById('echo').textContent` });
  if (echo.value !== 'kw=事件循环') throw new Error('echo=' + echo.value);
  return 'placeholder 定位成功，echo=' + echo.value;
});

// 14. 回归：导航到慢页面不能被旧文档的 readyState 骗过
await step('navigate 等的是新文档，不是旧文档', async () => {
  const r = await call('navigate', { url: '/api/slow', settleMs: 100 });
  if (!r.ok) throw new Error(JSON.stringify(r));
  if (!String(r.final || '').includes('/api/slow')) {
    throw new Error('返回了旧 URL：' + r.final);
  }
  const now = await call('run_js', { expression: 'location.pathname' });
  if (now.value !== '/api/slow') throw new Error('实际停在 ' + now.value);
  await call('navigate', { url: '/', settleMs: 600 });
  return 'final=' + r.final.replace(/^https?:\/\/[^/]+/, '');
});

// 15. 回归：fullPage 截图必须是整页高度，不是视口
await step('screenshot fullPage 截的是整页', async () => {
  // 先撑高页面，否则夹具在窄视口下本来就只占一屏
  await call('run_js', {
    expression: `(() => {
      const d = document.createElement('div');
      d.id = 'tall'; d.style.height = '1500px'; d.style.background = '#eee';
      document.body.appendChild(d);
      return document.documentElement.scrollHeight;
    })()`
  });
  await call('resize', { width: 400, height: 300 });
  const shot = await call('screenshot', { fullPage: true });
  await call('resize', { reset: true });
  await call('run_js', { expression: `document.getElementById('tall').remove(); 1` });
  if (!shot.path) throw new Error(JSON.stringify(shot));
  const ihdr = readPngSize(shot.path);
  if (!ihdr) throw new Error('读不到 PNG 尺寸');
  if (ihdr.height < 1200) throw new Error(`高度只有 ${ihdr.height}，像是只截了视口（300）`);
  return `${ihdr.width}×${ihdr.height}（注入 1500px 内容，视口高 300）`;
});

// 16. 回归：点击导航型链接后仍能给出结果
await step('interact 点击导航链接不崩', async () => {
  await call('navigate', { url: '/', settleMs: 600 });
  const r = await call('interact', { action: 'click', selector: '#to-json', settleMs: 800 });
  if (!r.ok) throw new Error(JSON.stringify(r));
  const now = await call('run_js', { expression: 'location.pathname' });
  if (now.value !== '/api/items') throw new Error('没有导航到 /api/items，实际 ' + now.value);
  await call('navigate', { url: '/', settleMs: 600 });
  return '导航到 ' + now.value + '，changed=' + (r.changed ? '有' : '无（已说明原因）');
});

await sleep(200);
const failed = checks.filter(c => !c.pass);
console.log(JSON.stringify({
  summary: { total: checks.length, pass: checks.length - failed.length, fail: failed.length },
  failed,
  passed: checks.filter(c => c.pass).map(c => '  ✓ ' + c.name + (c.detail ? '  —  ' + c.detail : ''))
}, null, 2));

console.log('RESULT ' + JSON.stringify({ suite: 'capabilities', ...{ total: checks.length, pass: checks.length - failed.length, fail: failed.length } }));

proc.kill();
process.exit(failed.length ? 1 : 0);
