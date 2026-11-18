#!/usr/bin/env node
/**
 * mcp-cdp/server.mjs —— 零依赖 MCP server，让 AI 通过 CDP 看页面内容 / 行为 / 网络
 *
 * 环境变量：
 *   CDP_ENDPOINT        默认 http://127.0.0.1:9222
 *   CDP_URL_CONTAINS    有多个标签时，按 URL 片段挑一个
 *   CDP_CAPTURE_DIR     大 body 落盘目录，默认 ./.cdp-capture
 *
 * stdout 只走 JSON-RPC，日志一律 stderr。
 */
import { createInterface } from 'node:readline';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// 复用已经验证过的样式快照脚本（含 CSS 变量溯源、变体去重）
let SNAPSHOT_SRC = null;
try {
  SNAPSHOT_SRC = readFileSync(new URL('../trae-style-snapshot/style-snapshot.js', import.meta.url), 'utf8')
    .replace(/^.*console\.log\('\[style-snapshot\].*$/m, ''); // 别污染页面 console
} catch (e) {
  console.error('[mcp-cdp] 没找到 style-snapshot.js，element_style 将不可用:', e.message);
}

const ENDPOINT = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
const CAPTURE_DIR = process.env.CDP_CAPTURE_DIR || '.cdp-capture';
const MAX_REQUESTS = 500;
const MAX_LOGS = 800;
const BODY_INLINE_LIMIT = 8000;   // 超过就落盘，只回预览
const BODY_EAGER_LIMIT = 256 * 1024;

const log = (...a) => console.error('[mcp-cdp]', ...a);

// ------------------------------------------------------------------ 状态
const state = {
  requests: new Map(),   // requestId -> record
  order: [],             // requestId 顺序
  logs: [],              // {ts, level, source, text}
  skipped: 0
};

function pushRequest(rec) {
  state.requests.set(rec.requestId, rec);
  state.order.push(rec.requestId);
  while (state.order.length > MAX_REQUESTS) {
    const old = state.order.shift();
    state.requests.delete(old);
  }
  return rec;
}

function pushLog(entry) {
  state.logs.push(entry);
  while (state.logs.length > MAX_LOGS) state.logs.shift();
}

function reset() {
  state.requests.clear();
  state.order.length = 0;
  state.logs.length = 0;
  state.skipped = 0;
}

// ------------------------------------------------------------------ CDP
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message || JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        const hs = this.handlers.get(msg.method);
        if (hs) hs.forEach(fn => { try { fn(msg.params); } catch (e) { log('handler error', e.message); } });
      }
    });
  }

  static async connectTo(target) {
    const ws = new WebSocket(target.ws);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('连不上 target: ' + target.url)), { once: true });
    });
    return new CDP(ws);
  }

  close() { try { this.ws.close(); } catch {} }

  send(method, params = {}) {
    if (!this.alive()) return Promise.reject(new Error('CDP 连接已断开: ' + method));
    const id = ++this.id;
    return new Promise((res, rej) => {
      // 定时器必须在成功/失败时清掉，否则每个请求都留一个 15s 的空定时器
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error('CDP 超时: ' + method));
        }
      }, 15000);
      if (timer.unref) timer.unref();

      this.pending.set(id, {
        res: v => { clearTimeout(timer); res(v); },
        rej: e => { clearTimeout(timer); rej(e); }
      });

      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        rej(e);
      }
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(fn);
  }

  alive() { return this.ws.readyState === 1; }
}

let currentConn = null;
let currentTargetId = null;
let pinnedTargetId = null;

async function listPageTargets() {
  const res = await fetch(ENDPOINT + '/json/list');
  const all = await res.json();
  return all
    .filter(t => t.type === 'page' && t.webSocketDebuggerUrl)
    .map(t => ({ id: t.id, url: t.url, title: t.title, ws: t.webSocketDebuggerUrl }));
}

function isBoring(t) { return /^(chrome|devtools|chrome-extension|about:)/.test(t.url) || t.url === ''; }

function pickTarget(list) {
  if (pinnedTargetId) {
    const hit = list.find(t => t.id === pinnedTargetId);
    if (hit) return hit;                       // 钉住了就一直在，标签没了才放开
    pinnedTargetId = null;
  }
  const wanted = process.env.CDP_URL_CONTAINS;
  if (wanted) {
    const hit = list.find(t => (t.url + ' ' + t.title).includes(wanted));
    if (hit) return hit;
  }
  // 优先真正有内容的页面，跳过空白页和浏览器内部页
  return list.find(t => !isBoring(t)) || list[0];
}

async function connectNow() {
  const list = await listPageTargets();
  if (!list.length) {
    throw new Error('没有可调试的页面。Chrome 需要用 --remote-debugging-port 启动，并至少开一个标签。');
  }
  const target = pickTarget(list);

  if (currentConn && currentConn.alive() && currentTargetId === target.id) return currentConn;

  // 换了页面就重连，并把旧页面的采集清掉，免得两个页面的日志混在一起
  const switching = currentTargetId !== null && currentTargetId !== target.id;
  if (currentConn) currentConn.close();
  currentConn = null;
  currentTargetId = null;
  if (switching) reset();

  const c = await CDP.connectTo(target);
  try {
    await c.send('Network.enable', { maxTotalBufferSize: 100 * 1024 * 1024 });
    await c.send('Runtime.enable');
    await c.send('Page.enable');
    await c.send('Log.enable');
  } catch (e) {
    c.close();          // 半连接不能留着，否则它照样往共享缓冲里写事件
    throw e;
  }
  install(c);

  currentConn = c;
  currentTargetId = target.id;
  log('已连接', target.title || '(无标题)', '→', target.url);
  return c;
}

// 单飞：并发调用共享同一次建连。
// 少了这层，N 个并发工具调用会各自越过 currentConn 判断、各建一条 CDP WebSocket，
// 那条被丢弃的连接仍在收事件，于是同一份 console/网络被记录 N 遍。
let ensurePromise = null;

function ensure() {
  if (ensurePromise) return ensurePromise;
  ensurePromise = connectNow().finally(() => { ensurePromise = null; });
  return ensurePromise;
}

// 工具调用串行化：采集缓冲、currentConn、target 都是共享状态，
// 并发执行会让 recorder/use_target 这类会改状态的调用和读操作互相穿插。
let toolChain = Promise.resolve();

function serialize(fn) {
  const run = toolChain.then(fn);
  toolChain = run.then(() => {}, () => {});
  return run;
}

async function listTargets() {
  const list = await listPageTargets();
  const picked = pickTarget(list);
  return {
    endpoint: ENDPOINT,
    pinned: pinnedTargetId || null,
    current: currentTargetId || (picked && picked.id) || null,
    targets: list.map((t, i) => ({
      index: i,
      id: t.id,
      title: t.title,
      url: truncate(t.url, 120),
      selected: picked && t.id === picked.id
    }))
  };
}

async function useTarget(args = {}) {
  const list = await listPageTargets();
  let hit = null;
  if (args.id) hit = list.find(t => t.id === args.id);
  else if (args.urlContains) hit = list.find(t => (t.url + ' ' + t.title).includes(args.urlContains));
  else if (typeof args.index === 'number') hit = list[args.index];
  if (!hit) {
    return { error: '没找到匹配的标签，先用 targets 看列表再选', available: list.map((t, i) => ({ index: i, url: truncate(t.url, 100) })) };
  }
  pinnedTargetId = hit.id;
  currentTargetId = null;   // 强制下次 ensure 重连
  reset();
  await ensure();
  return { ok: true, selected: { id: hit.id, title: hit.title, url: hit.url }, note: '之后所有工具都作用于这个标签，直到它关闭或用 use_target 改' };
}

// ------------------------------------------------------------------ 采集
function truncate(s, n) { return s.length > n ? s.slice(0, n) + `…(${s.length - n} more chars)` : s; }

function formatArg(a) {
  if (!a) return '';
  if (a.type === 'string') return a.value;
  if (a.type === 'undefined') return 'undefined';
  if (a.unserializableValue) return a.unserializableValue;
  if ('value' in a) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
  if (a.preview) {
    const p = a.preview;
    if (p.subtype === 'array') return '[' + p.properties.map(x => x.value).join(', ') + ']';
    if (p.properties) return '{' + p.properties.map(x => x.name + ': ' + x.value).join(', ') + '}';
  }
  return a.description || a.type;
}

function install(c) {
  c.on('Network.requestWillBeSent', p => {
    const rec = pushRequest({
      requestId: p.requestId,
      method: p.request.method,
      url: p.request.url,
      postData: p.request.postData ? truncate(p.request.postData, 2000) : undefined,
      hasPostData: p.request.hasPostData || undefined,
      reqHeaders: p.request.headers,
      startTs: Date.now(),
      status: undefined,
      mimeType: undefined,
      size: undefined,
      failed: false,
      resourceType: p.type
    });

    // postData 在协议里是可选的，有些请求要单独取
    if (rec.postData === undefined && (p.request.hasPostData || /^(POST|PUT|PATCH)$/.test(p.request.method))) {
      rec.postDataPromise = c.send('Network.getRequestPostData', { requestId: p.requestId })
        .then(r => { if (r && r.postData) rec.postData = truncate(r.postData, 2000); })
        .catch(() => { /* 请求已释放，就只能没有 */ });
    }
  });

  c.on('Network.responseReceived', p => {
    const rec = state.requests.get(p.requestId);
    if (!rec) return;
    rec.status = p.response.status;
    rec.mimeType = p.response.mimeType;
    rec.resHeaders = p.response.headers;
    // 缓存命中时 encodedDataLength 仍是解码后大小，不标出来会让人误判首屏体积
    rec.fromCache = !!(p.response.fromDiskCache || p.response.fromServiceWorker || p.response.fromPrefetchCache);
  });

  c.on('Network.loadingFinished', p => {
    const rec = state.requests.get(p.requestId);
    if (!rec) return;
    rec.size = p.encodedDataLength;
    rec.endTs = Date.now();
    const mt = rec.mimeType || '';
    const textual = /json|text|javascript|xml|html|csv|graphql/i.test(mt);
    if (textual && (p.encodedDataLength || 0) < BODY_EAGER_LIMIT) {
      // body 有时效：请求结束后要尽快取，页面导航后就取不到了
      rec.bodyPromise = c.send('Network.getResponseBody', { requestId: p.requestId })
        .then(r => {
          if (r.base64Encoded) { rec.bodyOmitted = 'binary'; return; }
          storeBody(rec, r.body);
        })
        .catch(e => { rec.bodyOmitted = '已释放: ' + e.message; });
    }
  });

  c.on('Network.loadingFailed', p => {
    const rec = state.requests.get(p.requestId);
    if (!rec) return;
    rec.failed = true;
    rec.errorText = p.errorText;
    rec.endTs = Date.now();
  });

  c.on('Runtime.consoleAPICalled', p => {
    // CDP 里 console.warn 的 type 是 'warning'，不是 'warn' —— 统一成人们会输入的那个
    const level = p.type === 'warning' ? 'warn' : p.type;
    pushLog({
      ts: Date.now(),
      level: level,
      source: 'console',
      text: truncate(p.args.map(formatArg).join(' '), 2000)
    });
  });

  c.on('Runtime.exceptionThrown', p => {
    const d = p.exceptionDetails || {};
    pushLog({
      ts: Date.now(),
      level: 'exception',
      source: 'runtime',
      text: truncate((d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown', 2000),
      url: d.url,
      line: d.lineNumber
    });
  });

  c.on('Log.entryAdded', p => {
    const e = p.entry || {};
    pushLog({
      ts: e.timestamp || Date.now(),
      level: e.level,
      source: 'log:' + (e.source || ''),
      text: truncate(e.text || '', 2000),
      url: e.url
    });
  });

  c.on('Page.frameNavigated', p => {
    if (p.frame && !p.frame.parentId) {
      pushLog({ ts: Date.now(), level: 'info', source: 'navigation', text: '→ ' + p.frame.url });
    }
  });
}

function storeBody(rec, body) {
  rec.bodySize = body.length;
  if (body.length <= BODY_INLINE_LIMIT) {
    rec.body = body;
    return;
  }
  try {
    mkdirSync(CAPTURE_DIR, { recursive: true });
    const safe = rec.requestId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const ext = (rec.mimeType || '').includes('json') ? 'json'
      : /html/.test(rec.mimeType || '') ? 'html' : 'txt';
    // 绝对路径：AI 拿到相对路径不知道相对谁，读不了
    const file = resolve(CAPTURE_DIR, `${safe}.${ext}`);
    writeFileSync(file, body);
    rec.bodyPath = file;
    rec.bodyPreview = truncate(body, 1500);
  } catch (e) {
    rec.body = truncate(body, BODY_INLINE_LIMIT);
  }
}

// ------------------------------------------------------------------ 工具实现
function groupKey(url) {
  let u;
  try { u = new URL(url); } catch { return url.slice(0, 80); }
  if (u.protocol === 'data:') return 'data:…';
  const path = u.pathname
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{20,}/gi, '/:uuid')
    .replace(/\/\d+/g, '/:id');
  return u.host + path;
}

async function pageOverview() {
  const c = await ensure();
  const r = await c.send('Runtime.evaluate', {
    expression: `(() => {
      const counts = {};
      document.querySelectorAll('*').forEach(el => {
        const t = el.tagName.toLowerCase();
        counts[t] = (counts[t] || 0) + 1;
      });
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12);
      return {
        title: document.title,
        url: location.href,
        readyState: document.readyState,
        nodeCount: document.querySelectorAll('*').length,
        textLength: document.body ? document.body.innerText.length : 0,
        topTags: top,
        landmarks: Array.from(document.querySelectorAll('main,header,nav,aside,footer,form'))
          .slice(0, 10)
          .map(e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '')),
        viewport: innerWidth + 'x' + innerHeight
      };
    })()`,
    returnByValue: true
  });

  const groups = {};
  for (const id of state.order) {
    const rec = state.requests.get(id);
    if (!rec) continue;
    const k = rec.method + ' ' + groupKey(rec.url);
    if (!groups[k]) groups[k] = { key: k, count: 0, statuses: {}, failed: 0 };
    groups[k].count++;
    groups[k].statuses[rec.status ?? (rec.failed ? 'FAILED' : '?')] =
      (groups[k].statuses[rec.status ?? (rec.failed ? 'FAILED' : '?')] || 0) + 1;
    if (rec.failed) groups[k].failed++;
  }

  const byLevel = {};
  state.logs.forEach(l => { byLevel[l.level] = (byLevel[l.level] || 0) + 1; });

  // 页面自己的 Performance API。注意：它可能比真实请求少（实测字体请求就没有条目），
  // 所以只作参考，冲突时以 captured.requests 为准。
  let pagePerf = null;
  try {
    const pr = await c.send('Runtime.evaluate', {
      expression: `(() => {
        const res = performance.getEntriesByType('resource');
        const sum = k => res.reduce((s, r) => s + (r[k] || 0), 0);
        return {
          resourceEntries: res.length,
          transferKB: +(sum('transferSize') / 1024).toFixed(1),
          decodedKB: +(sum('decodedBodySize') / 1024).toFixed(1)
        };
      })()`,
      returnByValue: true
    });
    pagePerf = pr.result && pr.result.value;
    if (pagePerf) {
      pagePerf.note = '页面自己的 Performance API；条目可能少于实际请求（字体常见），冲突时以 captured.requests 为准';
    }
  } catch (e) { /* 拿不到就算了 */ }

  return {
    page: r.result.value,
    pagePerf: pagePerf,
    captured: {
      requests: state.requests.size,
      droppedRequests: state.skipped,
      logs: state.logs.length,
      logLevels: byLevel,
      failedRequests: Array.from(state.requests.values()).filter(x => x.failed).length
    },
    requestGroups: Object.values(groups).sort((a, b) => b.count - a.count).slice(0, 15),
    recentErrors: state.logs.filter(l => l.level === 'error' || l.level === 'exception').slice(-5)
  };
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

async function networkList(args = {}) {
  await ensure();
  const limit = Math.min(args.limit || 30, 200);
  const out = [];
  for (const id of state.order.slice().reverse()) {
    const r = state.requests.get(id);
    if (!r) continue;
    if (args.url && !r.url.includes(args.url)) continue;
    if (args.method && r.method !== args.method.toUpperCase()) continue;
    if (args.failedOnly && !r.failed) continue;
    if (args.status && String(r.status) !== String(args.status)) continue;
    // 命中缓存时 encodedDataLength 是 0，退回 Content-Length，否则看起来像空响应
    const size = r.size || Number(headerValue(r.resHeaders, 'content-length')) || undefined;
    out.push({
      requestId: r.requestId,
      method: r.method,
      url: truncate(r.url, 160),
      status: r.status,
      mimeType: r.mimeType,
      size: size,
      ms: r.endTs && r.startTs ? r.endTs - r.startTs : undefined,
      failed: r.failed || undefined,
      errorText: r.errorText,
      fromCache: r.fromCache || undefined,
      body: r.bodyPath ? 'file:' + r.bodyPath : (r.body !== undefined ? 'inline' : (r.bodyOmitted || 'pending'))
    });
    if (out.length >= limit) break;
  }
  return { total: state.requests.size, returned: out.length, requests: out };
}

async function networkGet(args = {}) {
  await ensure();
  const r = state.requests.get(args.requestId);
  if (!r) return { error: '没有这个 requestId，先用 network_list 拿' };
  if (args.waitBody) {
    if (r.postDataPromise) { try { await r.postDataPromise; } catch {} }
    if (r.bodyPromise) { try { await r.bodyPromise; } catch {} }
  }

  // data: URL 的 URL 本身就是响应体，原样返回等于把 body 灌两遍
  const shownUrl = /^data:/i.test(r.url) && r.url.length > 200
    ? r.url.slice(0, 120) + `…(data: URL 共 ${r.url.length} 字符，正文见 body)`
    : r.url;

  const out = {
    requestId: r.requestId,
    method: r.method,
    url: shownUrl,
    status: r.status,
    mimeType: r.mimeType,
    requestHeaders: r.reqHeaders,
    responseHeaders: r.resHeaders,
    postData: r.postData,
    size: r.size,
    failed: r.failed || undefined,
    errorText: r.errorText
  };

  if (args.includeBody !== false) {
    if (r.bodyPath) {
      out.bodyFile = r.bodyPath;
      out.bodySize = r.bodySize;
      out.bodyPreview = r.bodyPreview;
      out.note = '响应体太大已落盘，完整内容读 bodyFile';
    } else if (r.body !== undefined) {
      out.body = truncate(r.body, args.maxBody || 4000);
      out.bodySize = r.bodySize;
    } else if (r.bodyOmitted) {
      out.bodyOmitted = r.bodyOmitted;
    } else {
      out.bodyOmitted = '未捕获（非文本类型，或请求还没结束）';
    }
  }
  return out;
}

// ------------------------------------------------------------------ 元素样式
// 把「给个选择器，返回目标样式」做成一个正式工具。
// 复用 style-snapshot.js：它已经在 Chrome 里验证过 37 条断言。
const PROP_GROUPS = {
  background: ['bg', 'bgImage', 'backdropFilter'],
  bg: ['bg', 'bgImage'],
  shadow: ['shadow'],
  border: ['border', 'radius'],
  radius: ['radius'],
  spacing: ['padding', 'margin', 'gap'],
  layout: ['display', 'flexDirection', 'alignItems', 'justifyContent', 'sizeRange'],
  typography: ['font', 'color', 'letterSpacing', 'textAlign'],
  color: ['color'],
  effect: ['opacity', 'filter', 'shadow', 'backdropFilter'],
  vars: ['vars']
};

// 这几项是上下文，任何过滤下都保留
const ALWAYS = new Set(['sel', 'tag', 'class', 'count', 'text', 'size']);

// vars 的每个桶对应哪个属性，用来跟着一起过滤
const VAR_BUCKET_TO_PROP = {
  bg: 'bg', color: 'color', shadow: 'shadow', radius: 'radius', gap: 'gap', font: 'font'
};

function normalizePropList(p) {
  if (!p) return null;
  const list = Array.isArray(p) ? p : String(p).split(',');
  const allow = new Set();
  list.map(x => String(x).trim().toLowerCase()).filter(Boolean).forEach(name => {
    if (PROP_GROUPS[name]) PROP_GROUPS[name].forEach(k => allow.add(k));
    else allow.add(name);
  });
  return allow;
}

function pickProps(node, allow) {
  if (!allow) return node;
  const out = {};
  for (const k of Object.keys(node)) {
    if (k === 'vars') continue;
    if (ALWAYS.has(k) || allow.has(k)) out[k] = node[k];
  }
  // 变量溯源跟着过滤走：问背景就保留 vars.bg，不要一股脑塞回去
  if (node.vars) {
    const pruned = {};
    for (const vb of Object.keys(node.vars)) {
      const prop = VAR_BUCKET_TO_PROP[vb] || vb;
      if (allow.has('vars') || allow.has(prop)) pruned[vb] = node.vars[vb];
    }
    if (Object.keys(pruned).length) out.vars = pruned;
  }
  return out;
}

async function elementStyle(args = {}) {
  if (!SNAPSHOT_SRC) {
    throw new Error('style-snapshot.js 不在 ../trae-style-snapshot/ 下，element_style 不可用');
  }
  const raw = String(args.selector || '').trim();
  if (!raw) throw new Error('需要 selector，比如 ".skill-block"、"#app"、"header" 或 "skill-block"');

  const max = Math.min(args.max || 6, 20);
  const c = await ensure();

  // 一次 evaluate 搞定：注入脚本 + 解析选择器 + 取样式
  const expr = SNAPSHOT_SRC + `
;(function(){
  var raw = ${JSON.stringify(raw)};
  var tries = [raw, '#' + raw, '.' + raw];
  var used = null, els = null;
  for (var i = 0; i < tries.length; i++) {
    try {
      var e = document.querySelectorAll(tries[i]);
      if (e.length) { used = tries[i]; els = e; break; }
    } catch (err) {}
  }
  if (!els) return { error: '没有匹配到元素：' + raw };
  var r = window.snapAll(used, { max: ${max} });
  return { selectorInput: raw, selectorUsed: used, matched: els.length, snap: r };
})()`;

  const res = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (res.exceptionDetails) {
    throw new Error('页面里执行失败: ' + (res.exceptionDetails.text || ''));
  }
  const v = res.result && res.result.value;
  if (!v || v.error) return v || { error: '没有返回' };

  const allow = normalizePropList(args.properties);
  const nodes = (v.snap.nodes || []).map(n => pickProps(n, allow));

  const out = {
    selector: v.selectorUsed,
    selectorInput: v.selectorInput !== v.selectorUsed ? v.selectorInput : undefined,
    matched: v.matched,
    variants: nodes.length,
    nodes: nodes
  };
  if (allow) out.filteredTo = Array.from(allow);
  if (v.snap.scanTruncated) out.scanTruncated = v.snap.scanTruncated;
  if (v.snap.variantsTruncated) out.variantsTruncated = v.snap.variantsTruncated;
  return out;
}

async function consoleLogs(args = {}) {
  await ensure();
  const limit = Math.min(args.limit || 40, 300);
  let items = state.logs;
  if (args.level) {
    // 内部统一用 warn；顺手接受 'warning'，免得调用方踩坑
    const want = new Set(String(args.level).split(',').map(s => s.trim() === 'warning' ? 'warn' : s.trim()));
    items = items.filter(l => want.has(l.level));
  }
  if (args.contains) items = items.filter(l => l.text.includes(args.contains));
  return {
    total: state.logs.length,
    returned: Math.min(items.length, limit),
    logs: items.slice(-limit).map(l => ({
      level: l.level,
      source: l.source,
      text: truncate(l.text, args.maxText || 500),
      url: l.url
    }))
  };
}

async function runJs(args = {}) {
  const c = await ensure();
  const r = await c.send('Runtime.evaluate', {
    expression: args.expression,
    returnByValue: true,
    awaitPromise: args.awaitPromise !== false,
    userGesture: true
  });
  if (r.exceptionDetails) {
    return { error: r.exceptionDetails.text, detail: r.exceptionDetails.exception && r.exceptionDetails.exception.description };
  }
  const v = r.result;
  let value = v.value;
  if (value === undefined && v.description) value = v.description;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return {
    type: v.type,
    value: truncate(text == null ? 'undefined' : text, args.maxLength || 6000)
  };
}

async function recorder(args = {}) {
  const c = await ensure();
  const action = args.action || 'status';
  if (action === 'clear') { reset(); return { ok: true, cleared: true }; }
  if (action === 'reload') {
    reset();
    await c.send('Page.reload', { ignoreCache: !!args.ignoreCache });
    // 给导航和首批请求一点时间
    await new Promise(r => setTimeout(r, args.waitMs || 1500));
    return { ok: true, reloaded: true, requests: state.requests.size, logs: state.logs.length };
  }
  return {
    requests: state.requests.size,
    logs: state.logs.length,
    endpoint: ENDPOINT
  };
}

// ------------------------------------------------------------------ MCP
const TOOLS = [
  {
    name: 'targets',
    description: '列出所有可调试的标签页，标出当前连的是哪个。新开了标签但工具读到的还是旧页面时，先调它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'use_target',
    description: '把当前会话切到某个标签页（按 index / id / url 片段）。切换会清空已采集的请求和日志。',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'targets 列表里的序号' },
        id: { type: 'string', description: '标签页 id' },
        urlContains: { type: 'string', description: 'URL 或标题包含的片段' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'page_overview',
    description: '页面总览：标题/URL/DOM 规模/文本长度/主要区块，加上已捕获的请求分组、日志计数、最近错误。先调它建立全局印象，再按需下钻。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'network_list',
    description: '列出已捕获请求的摘要（不含 body）。支持按 url 片段、method、status、只看失败过滤。返回的 requestId 用于 network_get 下钻。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL 包含的片段' },
        method: { type: 'string', description: 'GET/POST/...' },
        status: { type: ['string', 'number'], description: '精确状态码' },
        failedOnly: { type: 'boolean', description: '只看失败请求' },
        limit: { type: 'number', description: '默认 30，最多 200' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'network_get',
    description: '取单条请求的完整信息：请求/响应头、POST 体、响应体。超过 8000 字的响应体落盘，只返回文件路径和预览。',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string' },
        includeBody: { type: 'boolean', description: '默认 true' },
        maxBody: { type: 'number', description: '内联 body 上限，默认 4000' },
        waitBody: { type: 'boolean', description: '等 body 抓取完成' }
      },
      required: ['requestId'],
      additionalProperties: false
    }
  },
  {
    name: 'element_style',
    description: '给一个选择器，返回它「渲染后」的样式：背景、阴影、边框、圆角、间距、字体、颜色，以及每个值来自哪个 CSS 变量。多个同款元素会按样式去重成变体。不看源码，直接读浏览器实际画出来的值。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: '任意 CSS 选择器（#id / .class / 标签 / 组合），也可以只写裸名字如 "skill-block"，会自动尝试 #skill-block 和 .skill-block'
        },
        properties: {
          type: 'array',
          items: { type: 'string' },
          description: '只返回关心的方面：background / shadow / border / radius / spacing / layout / typography / color / effect / vars。不传返回全部'
        },
        max: { type: 'number', description: '最多返回几个变体，默认 6' }
      },
      required: ['selector'],
      additionalProperties: false
    }
  },
  {
    name: 'console_logs',
    description: '读 console 输出、未捕获异常、浏览器日志（含 CSP/网络错误）。可按级别、关键字过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', description: '逗号分隔：log,info,warn,error,exception,debug' },
        contains: { type: 'string', description: '文本包含' },
        limit: { type: 'number', description: '默认 40，最多 300' },
        maxText: { type: 'number', description: '单条文本上限，默认 500' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'run_js',
    description: '在页面里执行 JavaScript 并返回值。这是逃生舱：读 DOM、算样式、点按钮、调接口都靠它。也可以用它注入现成的采集脚本。',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string' },
        awaitPromise: { type: 'boolean', description: '默认 true' },
        maxLength: { type: 'number', description: '返回值上限，默认 6000' }
      },
      required: ['expression'],
      additionalProperties: false
    }
  },
  {
    name: 'recorder',
    description: '控制采集会话：clear 清空缓冲，reload 重新加载页面并从头录（attach 之前的请求是抓不到的，要抓全量就用 reload），status 看当前缓冲。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'clear', 'reload'] },
        ignoreCache: { type: 'boolean' },
        waitMs: { type: 'number' }
      },
      additionalProperties: false
    }
  }
];

const IMPL = {
  targets: listTargets,
  use_target: useTarget,
  page_overview: pageOverview,
  network_list: networkList,
  network_get: networkGet,
  element_style: elementStyle,
  console_logs: consoleLogs,
  run_js: runJs,
  recorder: recorder
};

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'mcp-cdp', version: '0.1.0' }
      }
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return; }

  if (method === 'tools/call') {
    const name = params?.name;
    const fn = IMPL[name];
    if (!fn) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '未知工具: ' + name }], isError: true } });
      return;
    }
    try {
      const out = await serialize(() => fn(params.arguments || {}));
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } });
    } catch (e) {
      log('tool error', name, e.message);
      send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true }
      });
    }
    return;
  }

  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { log('bad json'); return; }
  handle(msg).catch(e => log('handle error', e.message));
});

// ---------------------------------------------------------------- 生命周期
function cleanup() {
  try { if (currentConn) currentConn.close(); } catch {}
}

// 宿主关 stdio / 发信号时收尾，别在浏览器里留一条孤儿 CDP 会话
rl.on('close', () => { cleanup(); process.exit(0); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

// 真崩溃必须留下痕迹，否则日志里和「被宿主 kill 掉」分不出来
process.on('unhandledRejection', e => {
  log('unhandledRejection:', (e && e.stack) || e);
});
process.on('uncaughtException', e => {
  log('uncaughtException:', (e && e.stack) || e);
  cleanup();
  process.exit(1);
});

log('ready, endpoint =', ENDPOINT);
