// 用最小 MCP 客户端（stdio JSON-RPC）验证 server.mjs：握手 → 列表 → 真实调用
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const SERVER = new URL('./server.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const proc = spawn(process.execPath, [SERVER], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CDP_URL_CONTAINS: '127.0.0.1:8799' }
});

const pending = new Map();
let idc = 0;
const rl = createInterface({ input: proc.stdout });
const stderrLines = [];

rl.on('line', line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});

createInterface({ input: proc.stderr }).on('line', l => stderrLines.push(l));

function rpc(method, params) {
  const id = ++idc;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('超时: ' + method)); } }, 30000);
  });
}

function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

async function call(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = (r.content || []).map(c => c.text).join('');
  if (r.isError) throw new Error(name + ' 失败: ' + text);
  try { return JSON.parse(text); } catch { return text; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const checks = [];
const record = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });

try {
  // ---- 1. 握手
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0' }
  });
  record('initialize 返回 serverInfo', init.serverInfo && init.serverInfo.name === 'mcp-cdp', init.serverInfo);
  record('声明了 tools 能力', !!(init.capabilities && init.capabilities.tools), init.capabilities);
  notify('notifications/initialized', {});

  // ---- 2. 工具列表
  const list = await rpc('tools/list', {});
  record('tools/list 返回 9 个工具', list.tools.length === 9, list.tools.map(t => t.name));
  record('每个工具有 inputSchema', list.tools.every(t => t.inputSchema && t.inputSchema.type === 'object'), null);

  // ---- 3. 从零开始录（attach 之前的请求抓不到，reload 才完整）
  const rec = await call('recorder', { action: 'reload', waitMs: 2500 });
  record('reload 后抓到请求', rec.requests > 0, rec);
  await sleep(1200);

  // ---- 4. 总览
  const ov = await call('page_overview');
  record('page_overview 读到标题', ov.page && ov.page.title === 'mcp-cdp fixture', ov.page && ov.page.title);
  record('page_overview 有 DOM 规模', ov.page && ov.page.nodeCount > 5, ov.page && ov.page.nodeCount);
  record('page_overview 抓到请求', ov.captured.requests >= 5, ov.captured);
  record('page_overview 分了组', ov.requestGroups && ov.requestGroups.length >= 2, (ov.requestGroups || []).map(g => g.key));
  record('page_overview 标出失败数', ov.captured.failedRequests >= 1, ov.captured.failedRequests);

  // ---- 5. 网络列表 + 失败过滤
  const all = await call('network_list', { limit: 50 });
  record('network_list 有结果', all.returned >= 5, { total: all.total, returned: all.returned });
  record('列表本身不含正文（每条都很短）',
    all.requests.every(r => JSON.stringify(r).length < 700),
    Math.max(...all.requests.map(r => JSON.stringify(r).length)));

  const failed = await call('network_list', { failedOnly: true });
  record('failedOnly 过滤出失败请求', failed.returned >= 1, (failed.requests || []).map(r => r.errorText));

  const post = await call('network_list', { method: 'POST' });
  record('method 过滤到 POST', post.returned >= 1 && post.requests.every(r => r.method === 'POST'), post.returned);

  const s500 = await call('network_list', { status: 500 });
  record('status 过滤到 500', s500.returned >= 1, s500.returned);
  const s404 = await call('network_list', { status: 404 });
  record('status 过滤到 404', s404.returned >= 1, s404.returned);

  // ---- 6. 下钻：小 body 内联
  const items = all.requests.find(r => r.url.includes('/api/items'));
  const detail = await call('network_get', { requestId: items.requestId, waitBody: true });
  record('network_get 拿到响应体', typeof detail.body === 'string' && detail.body.includes('"n":42'), detail.body);
  record('network_get 带请求头', !!detail.requestHeaders, Object.keys(detail.requestHeaders || {}).length);
  record('network_get 带响应头', !!detail.responseHeaders, Object.keys(detail.responseHeaders || {}).length);

  // 500 的响应体也要读得到（错误响应的 body 往往最重要）
  const failDetail = await call('network_get', { requestId: s500.requests[0].requestId, waitBody: true });
  record('500 的响应体能读到', typeof failDetail.body === 'string' && failDetail.body.includes('boom'), failDetail.body);

  // POST 的请求体
  const postDetail = await call('network_get', { requestId: post.requests[0].requestId, waitBody: true });
  record('POST 的 postData 被记录',
    typeof postDetail.postData === 'string' && postDetail.postData.includes('"a":1'), postDetail.postData);

  // ---- 7. 下钻：大 body 落盘
  const big = all.requests.find(r => r.url.includes('/api/big'));
  if (big) {
    const bigDetail = await call('network_get', { requestId: big.requestId, waitBody: true });
    record('大 body 落盘而不是塞上下文', !!bigDetail.bodyFile, bigDetail.bodyFile);
    record('大 body 只回预览', typeof bigDetail.bodyPreview === 'string' &&
      bodyLenOk(bigDetail.bodyPreview), (bigDetail.bodyPreview || '').length);
  } else {
    record('大 body 落盘而不是塞上下文', false, '没找到大请求');
  }

  // ---- 8. console
  const errs = await call('console_logs', { level: 'error,exception' });
  record('console_logs 过滤到错误', errs.logs.some(l => l.text.includes('boom')), errs.logs.map(l => l.text));
  record('console_logs 抓到未捕获异常', errs.logs.some(l => l.text.includes('未捕获的异常')),
    errs.logs.map(l => l.level + ' | ' + l.text.slice(0, 60)));
  record('抛出的对象参数被序列化', errs.logs.some(l => l.text.includes('code: 42')), errs.logs.map(l => l.text));

  const warns = await call('console_logs', { level: 'warn' });
  record('warn 级别能单独取', warns.logs.length >= 1, warns.logs.map(l => l.text));

  // ---- 9. 逃生舱
  const js = await call('run_js', { expression: 'document.title' });
  record('run_js 返回字符串', js.value === 'mcp-cdp fixture', js);

  const js2 = await call('run_js', {
    expression: '(() => { const b = document.getElementById("btn-a"); b.click(); return "clicked"; })()'
  });
  record('run_js 能触发行为', js2.value === 'clicked', js2);
  await sleep(400);
  const afterClick = await call('console_logs', { contains: 'btn-a clicked' });
  record('行为之后的新日志被采到', afterClick.logs.length >= 1, afterClick.logs.map(l => l.text));

  const bad = await call('run_js', { expression: 'document.querySelector(' });
  record('JS 语法错不崩，返回错误', !!bad.error, bad.error);

  // ---- 10. 多标签：新打开的页面能被发现并切过去
  await newTab('data:text/html,<title>second-page</title><h1>second</h1>');
  const tg = await call('targets');
  record('targets 列出了多个标签', tg.targets.length >= 2, tg.targets.map(t => t.url.slice(0, 40)));
  record('targets 标出了当前选中项', tg.targets.filter(t => t.selected).length === 1, tg.current);

  const sw = await call('use_target', { urlContains: 'second-page' });
  record('use_target 能切到新标签', sw.ok && sw.selected.url.includes('second-page'), sw.selected);
  const ov2 = await call('page_overview');
  record('切换后 page_overview 读的是新页面', ov2.page.title === 'second-page', ov2.page.title);
  record('切换后采集缓冲被清空', ov2.captured.requests === 0 && ov2.captured.logs === 0, ov2.captured);

  const back = await call('use_target', { urlContains: '127.0.0.1:8799' });
  const ov3 = await call('page_overview');
  record('能切回原页面', back.ok && ov3.page.title === 'mcp-cdp fixture', ov3.page.title);

  // ---- 11. element_style：选择器 → 目标样式
  const st = await call('element_style', { selector: 'button' });
  record('element_style 按标签取到样式', st.nodes && st.nodes[0] && st.nodes[0].bg === 'rgb(33, 38, 45)', st.nodes && st.nodes[0] && st.nodes[0].bg);
  record('element_style 带回圆角', st.nodes[0].radius === '6px', st.nodes[0].radius);
  record('element_style 带回边框', typeof st.nodes[0].border === 'string' && st.nodes[0].border.includes('1px solid'), st.nodes[0].border);

  const bare = await call('element_style', { selector: 'lead' });
  record('裸名字自动解析成 .class', bare.selector === '.lead', { input: bare.selectorInput, used: bare.selector });

  const filtered = await call('element_style', { selector: 'button', properties: ['background'] });
  const fn = filtered.nodes[0];
  record('properties 过滤只留背景', fn.bg && !('border' in fn) && !('shadow' in fn) && !('padding' in fn),
    Object.keys(fn));
  record('过滤后仍保留定位信息', !!fn.sel && !!fn.text, { sel: fn.sel, text: fn.text });

  const miss = await call('element_style', { selector: '.no-such-thing-xyz' }).catch(e => ({ error: String(e) }));
  record('选择器没命中时返回错误而不是抛栈', !!miss.error, miss.error);
} catch (e) {
  record('整体流程', false, e.message);
} finally {
  const failedCount = checks.filter(c => !c.pass).length;
  const report = {
    summary: { total: checks.length, pass: checks.length - failedCount, fail: failedCount },
    failed: checks.filter(c => !c.pass),
    all: checks.map(c => (c.pass ? 'PASS ' : 'FAIL ') + c.name),
    serverStderr: stderrLines.slice(-10)
  };
  writeFileSync(new URL('./test-result.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(`[test] ${report.summary.pass}/${report.summary.total} 通过，写入 test-result.json`);
  proc.kill();
  process.exit(failedCount ? 1 : 0);
}

async function newTab(url) {
  const EP = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
  try {
    await fetch(EP + '/json/new?' + encodeURIComponent(url), { method: 'PUT' });
  } catch {
    await fetch(EP + '/json/new?' + encodeURIComponent(url));
  }
  await sleep(700);
}

function bodyLenOk(p) { return p.length > 0 && p.length < 4000; }
