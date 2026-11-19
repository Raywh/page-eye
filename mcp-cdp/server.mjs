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
  skipped: 0,
  requestSeq: 0,         // 单调递增，缓冲淘汰后仍能算差
  logSeq: 0
};

function pushRequest(rec) {
  state.requests.set(rec.requestId, rec);
  state.order.push(rec.requestId);
  state.requestSeq++;
  while (state.order.length > MAX_REQUESTS) {
    const old = state.order.shift();
    state.requests.delete(old);
    state.skipped++;
  }
  return rec;
}

function pushLog(entry) {
  state.logs.push(entry);
  state.logSeq++;
  while (state.logs.length > MAX_LOGS) state.logs.shift();
}

// 切标签后连接换了，所有「属于上一条会话」的设置都要清掉，
// 否则 netState / viewportState / mocks 会宣称仍然生效但实际没作用。
function resetSession() {
  lastGoodOrigin = null;
  Object.assign(netState, { latency: 0, downloadKbps: 0, uploadKbps: 0, offline: false, cacheDisabled: false });
  viewportState.active = false;
  mocks.length = 0;
  pausedState = null;
  sheetUrls.clear();
  if (currentConn) { currentConn.send('Fetch.disable').catch(() => {}); }
}

function reset() {
  state.requests.clear();
  state.order.length = 0;
  state.logs.length = 0;
  state.skipped = 0;
  state.requestSeq = 0;
  state.logSeq = 0;
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

  close() {
    try { this.ws.close(); } catch {}
    for (const [, p] of this.pending) { try { p.rej(new Error('CDP 连接已关闭')); } catch {} }
    this.pending.clear();
  }

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
  if (switching) { reset(); resetSession(); }

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
  installExtra(c);

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
  resetSession();
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
    const existing = state.requests.get(p.requestId);
    if (existing) {   // 重定向：同一 requestId 再来一次，就地更新，别重复入队
      existing.url = p.request.url;
      existing.method = p.request.method;
      existing.reqHeaders = p.request.headers;
      existing.status = undefined;
      existing.mimeType = undefined;
      existing.size = undefined;
      existing.failed = false;
      existing.redirected = true;
      return;
    }
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
  const v = r.result || {};
  let value = v.value;
  if (value === undefined && v.description !== undefined) value = v.description;

  // 保留原始类型：布尔/数字原样返回，别一律 stringify 成字符串
  const maxLength = args.maxLength || 6000;
  let rendered;
  try { rendered = JSON.stringify(value); } catch { rendered = undefined; }
  if (rendered !== undefined && rendered.length > maxLength) {
    return { type: v.type, value: rendered.slice(0, maxLength) + '…(truncated)', truncated: true };
  }
  return { type: v.type, value: value === undefined ? null : value };
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

// ------------------------------------------------------------------ 扩展能力
// 这一组对应 DevTools 六大面板：元素、样式、调试、Console、性能、网络。
const sleep = ms => new Promise(r => setTimeout(r, ms));

const sheetUrls = new Map();   // styleSheetId -> sourceURL
const mocks = [];              // { re, status, body, headers }
let pauseWaiters = [];

function hexToRgb(hex) {
  const s = String(hex || '').trim();
  let m = /^#?([0-9a-f]{6})$/i.exec(s);
  if (m) { const v = parseInt(m[1], 16); return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 }; }
  m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  if (m) return { r: parseInt(m[1] + m[1], 16), g: parseInt(m[2] + m[2], 16), b: parseInt(m[3] + m[3], 16) };
  return { r: 0, g: 179, b: 255 };
}

function installExtra(c) {
  c.on('CSS.styleSheetAdded', p => {
    const h = p.header || {};
    if (!h.styleSheetId) return;
    sheetUrls.set(h.styleSheetId, h.sourceURL || h.origin || '(inline)');
    // 每次导航都会产生新的 styleSheetId，不设上限会无限增长
    if (sheetUrls.size > 400) {
      const oldest = sheetUrls.keys().next().value;
      sheetUrls.delete(oldest);
    }
  });

  c.on('Fetch.requestPaused', async p => {
    const hit = mocks.find(m => m.re.test(p.request.url));
    try {
      if (hit) {
        await c.send('Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: hit.status,
          responseHeaders: Object.entries(hit.headers).map(([name, value]) => ({ name, value: String(value) })),
          body: Buffer.from(hit.body).toString('base64')
        });
      } else {
        await c.send('Fetch.continueRequest', { requestId: p.requestId });
      }
    } catch (e) { log('fetch handler:', e.message); }
  });

  c.on('Debugger.paused', p => {
    pausedState = p;
    const w = pauseWaiters; pauseWaiters = [];
    w.forEach(fn => { try { fn(p); } catch {} });
  });

  c.on('Page.frameNavigated', p => {
    if (navWaiter && p.frame && !p.frame.parentId) {
      const w = navWaiter; navWaiter = null; w(p.frame);
    }
  });
}

// ---- 网络条件：禁缓存 / 限速 / 离线
const netState = { latency: 0, downloadKbps: 0, uploadKbps: 0, offline: false, cacheDisabled: false };

function throughput(kbps) { return kbps ? Math.round((kbps * 1024) / 8) : -1; }

async function pushNetConditions(c) {
  await c.send('Network.setCacheDisabled', { cacheDisabled: netState.cacheDisabled });
  await c.send('Network.emulateNetworkConditions', {
    offline: netState.offline,
    latency: netState.latency,
    downloadThroughput: throughput(netState.downloadKbps),
    uploadThroughput: throughput(netState.uploadKbps)
  });
}

async function netConditions(args = {}) {
  const c = await ensure();
  if (args.reset) {
    Object.assign(netState, { latency: 0, downloadKbps: 0, uploadKbps: 0, offline: false, cacheDisabled: false });
    await pushNetConditions(c);
    return { ok: true, reset: true, state: { ...netState } };
  }
  if (args.cacheDisabled !== undefined) netState.cacheDisabled = !!args.cacheDisabled;
  if (args.latencyMs !== undefined) netState.latency = Number(args.latencyMs);
  if (args.downloadKbps !== undefined) netState.downloadKbps = Number(args.downloadKbps);
  if (args.uploadKbps !== undefined) netState.uploadKbps = Number(args.uploadKbps);
  if (args.offline !== undefined) netState.offline = !!args.offline;
  await pushNetConditions(c);
  return {
    ok: true,
    state: { ...netState },
    note: '设置会一直生效，直到 reset 或再次调用；配合 recorder reload 量首屏更有意义'
  };
}

// ---- 无障碍树
async function a11yTree(args = {}) {
  const c = await ensure();
  await c.send('Accessibility.enable');
  const r = await c.send('Accessibility.getFullAXTree');
  const nodes = (r.nodes || []).filter(n => !n.ignored);
  const histogram = {};
  nodes.forEach(n => {
    const role = n.role && n.role.value;
    if (role) histogram[role] = (histogram[role] || 0) + 1;
  });
  const want = args.roles ? String(args.roles).split(',').map(s => s.trim()).filter(Boolean) : null;
  const limit = Math.min(args.limit || 60, 300);
  const picked = nodes
    .filter(n => n.name && n.name.value)
    .filter(n => !want || want.includes((n.role && n.role.value) || ''))
    .slice(0, limit)
    .map(n => {
      const lvl = (n.properties || []).find(p => p.name === 'level');
      return {
        role: n.role && n.role.value,
        name: truncate(String(n.name.value), 80),
        level: lvl && lvl.value ? lvl.value.value : undefined
      };
    });
  return {
    totalNodes: nodes.length,
    roleHistogram: Object.entries(histogram).sort((a, b) => b[1] - a[1]).slice(0, 15),
    returned: picked.length,
    nodes: picked
  };
}

// ---- CSS 规则覆盖率
async function cssCoverage(args = {}) {
  const c = await ensure();
  await c.send('DOM.enable');          // CSS 域依赖 DOM 域
  await c.send('CSS.enable');
  await c.send('CSS.startRuleUsageTracking');
  if (args.reload !== false) {
    await c.send('Page.reload', { ignoreCache: true });
    await sleep(args.waitMs || 3000);
  }
  const stop = await c.send('CSS.stopRuleUsageTracking');
  const usage = stop.ruleUsage || [];
  const bySheet = new Map();
  for (const u of usage) {
    if (!bySheet.has(u.styleSheetId)) {
      bySheet.set(u.styleSheetId, { url: sheetUrls.get(u.styleSheetId) || '(未知)', used: 0, unused: 0 });
    }
    const e = bySheet.get(u.styleSheetId);
    u.used ? e.used++ : e.unused++;
  }
  const used = usage.filter(u => u.used).length;
  const total = usage.length;
  return {
    rules: total,
    used,
    unused: total - used,
    unusedPct: total ? +(((total - used) / total) * 100).toFixed(1) : 0,
    sheets: Array.from(bySheet.values()).map(s => ({ ...s, url: truncate(s.url, 120) }))
  };
}

// ---- 媒体 / 深色 / 打印 模拟
async function emulateMedia(args = {}) {
  const c = await ensure();
  if (args.reset) {
    await c.send('Emulation.setEmulatedMedia', { media: '', features: [] });
    return { ok: true, reset: true };
  }
  const features = [];
  if (args.scheme) features.push({ name: 'prefers-color-scheme', value: args.scheme });
  if (args.reducedMotion) features.push({ name: 'prefers-reduced-motion', value: args.reducedMotion });
  if (args.forcedColors) features.push({ name: 'forced-colors', value: args.forcedColors });
  await c.send('Emulation.setEmulatedMedia', { media: args.media || '', features });
  const r = await c.send('Runtime.evaluate', {
    expression: `({
      scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyColor: getComputedStyle(document.body).color
    })`,
    returnByValue: true
  });
  return {
    ok: true,
    media: args.media || '',
    features,
    pageNow: r.result && r.result.value
  };
}

// ---- 截图（存盘，不把 base64 灌进上下文）
async function screenshot(args = {}) {
  const c = await ensure();
  const opts = { format: 'png' };
  let clip = null;
  if (args.selector) {
    const r = await c.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(args.selector)});
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height };
      })()`,
      returnByValue: true
    });
    clip = r.result && r.result.value;
    if (!clip) return { error: '没有匹配到元素：' + args.selector };
    if (!clip.width || !clip.height) return { error: '元素尺寸为 0，无法截图' };
    opts.clip = { ...clip, scale: 1 };
    opts.captureBeyondViewport = true;
  } else if (args.fullPage) {
    // 设备模拟开着时 Page.getLayoutMetrics 的 contentSize 会被裁到视口高度，
    // 直接问页面本身的滚动尺寸更可靠。
    const size = await evalValue(c, `({
      w: Math.max(document.documentElement.clientWidth, window.innerWidth),
      h: Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0,
        window.innerHeight
      )
    })`);
    if (size && size.w && size.h) {
      clip = { x: 0, y: 0, width: Math.ceil(size.w), height: Math.ceil(size.h), scale: 1 };
      opts.clip = clip;
    }
    opts.captureBeyondViewport = true;
  }
  const shot = await c.send('Page.captureScreenshot', opts);
  const buf = Buffer.from(shot.data, 'base64');
  mkdirSync(CAPTURE_DIR, { recursive: true });
  const file = resolve(CAPTURE_DIR, `shot-${Date.now()}.png`);
  writeFileSync(file, buf);
  return { path: file, bytes: buf.length, clip };
}

// ---- 视口：模拟不同屏幕宽度并体检布局
const viewportState = { active: false };

async function resize(args = {}) {
  const c = await ensure();

  if (args.reset) {
    await c.send('Emulation.clearDeviceMetricsOverride');
    viewportState.active = false;
    return { ok: true, reset: true };
  }

  const width = Number(args.width || 0);
  const height = Number(args.height || 0);
  if (!width || !height) throw new Error('需要 width 和 height（恢复默认用 reset: true）');

  const dsf = Number(args.deviceScaleFactor || 1);
  await c.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: dsf, mobile: !!args.mobile
  });
  Object.assign(viewportState, { active: true, width, height, mobile: !!args.mobile, dsf });

  if (args.reload) {
    await c.send('Page.reload', { ignoreCache: !!args.ignoreCache });
    await sleep(args.waitMs || 2500);
  }

  // 附带体检：横向溢出 + 过小的点按目标
  const r = await c.send('Runtime.evaluate', {
    expression: `(() => {
      const de = document.documentElement;
      const vw = de.clientWidth;
      const offenders = Array.from(document.querySelectorAll('body *'))
        .map(function (el) { return { el: el, b: el.getBoundingClientRect() }; })
        .filter(function (x) { return x.b.width > 0 && x.b.right > vw + 1; })
        .slice(0, 8)
        .map(function (x) {
          return {
            tag: x.el.tagName.toLowerCase(),
            cls: typeof x.el.className === 'string' ? x.el.className.split(' ').slice(0, 2).join('.') : '',
            right: Math.round(x.b.right),
            width: Math.round(x.b.width)
          };
        });
      const smallTargets = Array.from(document.querySelectorAll('button, a[href]'))
        .filter(function (el) { const b = el.getBoundingClientRect(); return b.width > 0 && (b.height < 32 || b.width < 32); })
        .length;
      return {
        viewport: vw + 'x' + de.clientHeight,
        windowWidth: window.innerWidth,
        scrollbarPx: Math.max(0, window.innerWidth - vw),
        scrollWidth: de.scrollWidth,
        horizontalOverflow: de.scrollWidth > vw + 1,
        overflowPx: Math.max(0, de.scrollWidth - vw),
        offenders: offenders,
        smallTapTargets: smallTargets
      };
    })()`,
    returnByValue: true
  });

  const measured = (r.result && r.result.value) || {};
  const out = { ok: true, applied: { ...viewportState }, ...measured };

  // 桌面端 clientWidth 会比 innerWidth 少一个滚动条宽度（约 15px），这是正常的。
  // 只有移动端模式下差得很大（页面按 980px 排版）才说明缺 viewport meta。
  const layoutW = parseInt(String(measured.viewport || '').split('x')[0], 10);
  const diff = layoutW ? Math.abs(layoutW - viewportState.width) : 0;
  if (viewportState.mobile && diff > 100) {
    out.note = `布局视口是 ${layoutW}px，而请求的是 ${viewportState.width}px —— `
      + '页面缺少 <meta name="viewport" content="width=device-width">，移动端会按 980px 排版再缩放';
  }
  return out;
}

// ---- 导航
let lastGoodOrigin = null;
let navWaiter = null;          // 等主 frame 提交
let pausedState = null;        // 最近一次 Debugger.paused

async function currentOrigin(c) {
  try {
    const o = await c.send('Runtime.evaluate', { expression: 'location.origin', returnByValue: true });
    const v = o.result && o.result.value;
    if (v && /^https?:\/\//.test(v)) return v;
  } catch (e) { /* 错误页 / 上下文失效 */ }
  return lastGoodOrigin;   // 回落到上一次成功的 origin，便于从错误页恢复
}

async function pollReady(c, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    await sleep(150);
    try {
      const r = await c.send('Runtime.evaluate', {
        expression: '({ href: location.href, ready: document.readyState, title: document.title })',
        returnByValue: true
      });
      last = r.result && r.result.value;
      if (last && last.ready === 'complete') return last;
    } catch (e) { /* 提交瞬间上下文会失效 */ }
  }
  return last;
}

async function navigate(args = {}) {
  const c = await ensure();
  let url = String(args.url || '').trim();
  if (!url) throw new Error('需要 url（绝对地址，或站内路径如 /add）');

  if (url.startsWith('/') || url.startsWith('?')) {
    const origin = await currentOrigin(c);
    if (!origin) {
      return {
        error: '当前页面没有可用的 origin（可能停在错误页），请传完整 URL',
        requested: url
      };
    }
    url = origin + url;
  }

  const timeout = Math.min(args.timeoutMs || 15000, 60000);

  // 先挂上 frameNavigated 等待器，再发导航：
  // 否则新文档提交前的 Runtime.evaluate 还在旧文档里跑，旧文档的 readyState
  // 天然是 complete，会立刻误判成「导航完成」。
  const committed = new Promise(res => {
    const t = setTimeout(() => { if (navWaiter) navWaiter = null; res(null); }, timeout);
    navWaiter = frame => { clearTimeout(t); navWaiter = null; res(frame); };
  });

  let nav;
  try {
    nav = await c.send('Page.navigate', { url });
  } catch (e) {
    navWaiter = null;
    return { error: '导航失败：' + (e && e.message || String(e)), requested: url };
  }
  if (nav.errorText) { navWaiter = null; return { error: nav.errorText, requested: url }; }

  const frame = await committed;
  if (!frame) {
    const now = await pollReady(c, 800);
    return {
      error: '导航超时：主 frame 没有在 ' + timeout + 'ms 内提交（可能被下载/重定向阻塞）',
      requested: url,
      final: now && now.href
    };
  }

  const last = await pollReady(c, timeout);
  if (!last) {
    return { error: '导航已提交但页面没有进入 complete', requested: url, final: frame.url };
  }

  if (args.settleMs !== 0) await sleep(args.settleMs || 400);

  if (last.href && /^https?:\/\//.test(last.href)) {
    try { lastGoodOrigin = new URL(last.href).origin; } catch (e) {}
  }

  return {
    ok: true,
    requested: url,
    final: last.href,
    title: last.title,
    readyState: last.ready,
    committedUrl: frame.url
  };
}

// ---- 交互：滚动 / 点击 / 填表 / 按键，并回报前后差值
async function pageSnapshot(c) {
  const r = await c.send('Runtime.evaluate', {
    expression: `({
      url: location.href,
      title: document.title,
      nodes: document.querySelectorAll('*').length,
      textLength: document.body ? document.body.innerText.length : 0,
      scrollY: Math.round(window.scrollY),
      scrollHeight: document.documentElement.scrollHeight
    })`,
    returnByValue: true
  });
  const v = (r.result && r.result.value) || {};
  return { ...v, requests: state.requestSeq, logs: state.logSeq };
}

async function safeSnapshot(c, tries = 12) {
  for (let i = 0; i < tries; i++) {
    try { return await pageSnapshot(c); } catch (e) { await sleep(150); }
  }
  return null;
}

async function evalValue(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面执行失败');
  return r.result && r.result.value;
}

async function doScroll(c, args) {
  const steps = Math.min(Number(args.steps) || 15, 80);
  const wait = Number(args.waitMs) || 450;
  const to = args.to === 'top' ? 'top' : 'bottom';

  if (to === 'top') {
    await evalValue(c, 'window.scrollTo(0, 0); 1');
    await sleep(wait);
    return { scrolled: 'top' };
  }

  const h0 = await evalValue(c, 'document.documentElement.scrollHeight');
  let lastH = h0, stagnant = 0, done = 0;

  for (let i = 0; i < steps; i++) {
    done++;
    await evalValue(c, 'window.scrollBy(0, Math.max(200, Math.round(innerHeight * 0.9))); 1');
    await sleep(wait);

    const h = await evalValue(c, 'document.documentElement.scrollHeight');
    const atBottom = await evalValue(c, '(innerHeight + scrollY) >= document.documentElement.scrollHeight - 2');

    if (h !== lastH) { lastH = h; stagnant = 0; }
    else if (atBottom) { stagnant++; if (stagnant >= 2) break; }   // 到底且高度不再变 → 没有再加载
  }

  const h1 = await evalValue(c, 'document.documentElement.scrollHeight');
  return { scrolled: 'bottom', steps: done, heightBefore: h0, heightAfter: h1, grewPx: h1 - h0 };
}

// 页面里找元素的统一入口：选择器 > placeholder > 文字
const FIND_JS = `
function __peFind(sel, text, ph) {
  if (sel) { const e = document.querySelector(sel); if (e) return e; }
  if (ph) {
    const e = document.querySelector('[placeholder*="' + ph + '"]');
    if (e) return e;
  }
  if (text) {
    const t = String(text).trim();
    const cands = Array.from(document.querySelectorAll('button,a,[role="button"],li,label,option'));
    return cands.find(e => (e.innerText || '').trim() === t)
        || cands.find(e => (e.innerText || '').trim().indexOf(t) === 0);
  }
  return null;
}
`;

function targetArgs(args) {
  return [JSON.stringify(args.selector || null), JSON.stringify(args.text || null), JSON.stringify(args.placeholder || null)].join(', ');
}

function describeTarget(args) {
  return args.selector || (args.placeholder ? `[placeholder*="${args.placeholder}"]` : null) || (args.text ? `文字「${args.text}」` : '(空)');
}

async function doClick(c, args) {
  const r = await evalValue(c, `(() => { ${FIND_JS}
    const el = __peFind(${targetArgs(args)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const label = (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
    el.click();
    return { clicked: el.tagName.toLowerCase(), label };
  })()`);
  return r || { error: '没有匹配到元素：' + describeTarget(args) };
}

async function doFill(c, args) {
  const value = args.value == null ? '' : String(args.value);
  const r = await evalValue(c, `(() => { ${FIND_JS}
    const el = __peFind(${targetArgs(args)});
    if (!el) return null;
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { filled: el.tagName.toLowerCase(), value: String(el.value).slice(0, 40) };
  })()`);
  return r || { error: '没有匹配到元素：' + describeTarget(args) };
}

async function doSelect(c, args) {
  return doFill(c, args);
}

async function doPress(c, args) {
  const key = String(args.key || 'Enter');
  const map = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 }
  };
  const k = map[key];
  if (!k) throw new Error('只支持 Enter / Tab / Escape / ArrowDown / ArrowUp');
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k, text: key === 'Enter' ? '\r' : undefined });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
  return { pressed: key };
}

async function interact(args = {}) {
  const c = await ensure();
  const action = String(args.action || '').trim();
  if (!['scroll', 'click', 'fill', 'select', 'press'].includes(action)) {
    throw new Error('action 只能是 scroll / click / fill / select / press');
  }

  const before = await safeSnapshot(c);
  let detail = {};

  if (action === 'scroll') detail = await doScroll(c, args);
  else if (action === 'click') detail = await doClick(c, args);
  else if (action === 'fill') detail = await doFill(c, args);
  else if (action === 'select') detail = await doSelect(c, args);
  else if (action === 'press') detail = await doPress(c, args);

  if (detail && detail.error) return { error: detail.error };

  await sleep(Math.min(Number(args.settleMs) || 900, 10000));   // 等请求与渲染
  const after = await safeSnapshot(c);

  // 点击可能触发导航：上下文会失效，safeSnapshot 会重试；都失败就明说，别假装没变化
  const changed = (before && after) ? {
    url: before.url !== after.url ? `${before.url} → ${after.url}` : undefined,
    nodes: after.nodes - before.nodes,
    textLength: after.textLength - before.textLength,
    requests: after.requests - before.requests,
    logs: after.logs - before.logs,
    scrollY: after.scrollY
  } : null;

  return {
    ok: true,
    action,
    ...detail,
    changed,
    ...(changed ? {} : { note: '页面在动作期间发生导航，前后快照不可比；detail 里的操作结果仍然有效' }),
    snapshot: { before, after }
  };
}

// ---- 请求 mock / 改响应
async function netMock(args = {}) {
  const c = await ensure();
  if (args.clear) {
    mocks.length = 0;
    try { await c.send('Fetch.disable'); } catch {}
    return { ok: true, cleared: true };
  }
  if (!args.urlPattern) throw new Error('需要 urlPattern（正则字符串，比如 "/api/items"）');
  mocks.push({
    re: new RegExp(args.urlPattern),
    status: args.status || 200,
    body: args.body || '',
    headers: args.headers || { 'content-type': 'application/json; charset=utf-8' }
  });
  await c.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  return {
    ok: true,
    rules: mocks.map(m => ({ pattern: m.re.source, status: m.status, bodyBytes: m.body.length })),
    note: '只影响之后的请求；用完记得 clear'
  };
}

// ---- JS 调试
async function debuggerCtl(args = {}) {
  const c = await ensure();
  const action = args.action || 'status';

  if (action === 'exceptions') {
    await c.send('Debugger.enable');
    const state = args.state || 'uncaught';
    await c.send('Debugger.setPauseOnExceptions', { state });
    return { ok: true, pauseOnExceptions: state };
  }
  if (action === 'break') {
    await c.send('Debugger.enable');
    const r = await c.send('Debugger.setBreakpointByUrl', {
      lineNumber: Math.max(0, Number(args.lineNumber || 0)),
      urlRegex: args.urlRegex || '.*'
    });
    return { ok: true, breakpointId: r.breakpointId, locations: (r.locations || []).length };
  }
  if (action === 'wait') {
    await c.send('Debugger.enable');
    const timeout = Math.min(args.timeoutMs || 8000, 30000);

    // 页面可能在 wait 之前就已经暂停（比如 exceptions 之后一报错就停下），
    // 那份状态要能立刻取用，否则会误报「没有暂停」。
    let paused = pausedState;
    pausedState = null;

    if (!paused) {
      paused = await new Promise(res => {
        let done = false;
        const waiter = p => { if (!done) { done = true; clearTimeout(t); res(p); } };
        const t = setTimeout(() => {
          if (done) return;
          done = true;
          pauseWaiters = pauseWaiters.filter(w => w !== waiter);   // 超时要摘掉，否则每次超时留一个闭包
          res(null);
        }, timeout);
        pauseWaiters.push(waiter);
      });
    }
    if (!paused) return { paused: false, note: timeout + 'ms 内没有暂停（确认先 exceptions 或 break）' };
    const frames = (paused.callFrames || []).slice(0, 8).map(f => ({
      fn: f.functionName || '(anonymous)',
      url: truncate(f.url, 120),
      line: f.location.lineNumber + 1
    }));
    if (args.resume !== false) { try { await c.send('Debugger.resume'); } catch {} }
    return { paused: true, reason: paused.reason, frames };
  }
  if (action === 'resume') { await c.send('Debugger.resume'); return { ok: true }; }
  if (action === 'off') {
    try { await c.send('Debugger.setPauseOnExceptions', { state: 'none' }); } catch {}
    try { await c.send('Debugger.disable'); } catch {}
    return { ok: true, off: true };
  }
  return { error: 'action 只能是 exceptions / break / wait / resume / off' };
}

// ---- 高亮元素
async function highlight(args = {}) {
  const c = await ensure();
  await c.send('DOM.enable');   // Overlay/DOM.getDocument 都依赖 DOM 域
  await c.send('Overlay.enable');
  if (args.clear) { await c.send('Overlay.hideHighlight'); return { ok: true, cleared: true }; }
  if (!args.selector) throw new Error('需要 selector');
  const doc = await c.send('DOM.getDocument', { depth: 1 });
  const q = await c.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: args.selector });
  if (!q.nodeId) return { error: '没有匹配到元素：' + args.selector };
  const rgb = hexToRgb(args.color || '#00b3ff');
  await c.send('Overlay.highlightNode', {
    nodeId: q.nodeId,
    highlightConfig: {
      showInfo: true,
      contentColor: { ...rgb, a: 0.25 },
      paddingColor: { r: 0, g: 200, b: 120, a: 0.2 },
      borderColor: { r: 255, g: 160, b: 0, a: 0.5 }
    }
  });
  return { ok: true, selector: args.selector, nodeId: q.nodeId };
}

// ---- 性能指标
async function perfMetrics() {
  const c = await ensure();
  await c.send('Performance.enable');
  const r = await c.send('Performance.getMetrics');
  const all = {};
  (r.metrics || []).forEach(m => { all[m.name] = m.value; });
  const pick = [
    'Documents', 'Frames', 'Nodes', 'JSEventListeners',
    'LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration',
    'ScriptDuration', 'TaskDuration', 'JSHeapUsedSize', 'JSHeapTotalSize'
  ];
  const out = {};
  pick.forEach(k => { if (typeof all[k] === 'number') out[k] = +all[k].toFixed(4); });
  out.JSHeapUsedMB = all.JSHeapUsedSize ? +(all.JSHeapUsedSize / 1048576).toFixed(1) : undefined;
  if (out.JSHeapUsedMB === undefined) delete out.JSHeapUsedMB;
  return { metrics: out };
}

// ---- 帧与子 target
async function frames() {
  const c = await ensure();
  const tree = await c.send('Page.getFrameTree');
  const flat = [];
  (function walk(node) {
    if (!node || !node.frame) return;
    flat.push({
      id: node.frame.id,
      url: truncate(node.frame.url || '(空)', 140),
      parentId: node.frame.parentId || undefined
    });
    (node.childFrames || []).forEach(walk);
  })(tree.frameTree);

  let detached = [];
  try {
    const t = await c.send('Target.getTargets');
    detached = (t.targetInfos || [])
      .filter(x => ['iframe', 'worker', 'shared_worker', 'service_worker'].includes(x.type))
      .map(x => ({ type: x.type, url: truncate(x.url, 140), attached: !!x.attached }));
  } catch (e) { /* 某些构建不支持 */ }

  return {
    frameCount: flat.length,
    frames: flat,
    subTargets: detached,
    note: '跨域 iframe / worker 的内容要 Target.setAutoAttach 之后才读得到；这里只列出来'
  };
}


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
  },
  {
    name: 'net_conditions',
    description: '设置网络条件：禁缓存、模拟带宽与延迟、离线。配合 recorder reload 能量化真实首屏。',
    inputSchema: {
      type: 'object',
      properties: {
        cacheDisabled: { type: 'boolean', description: '禁用 HTTP 缓存' },
        latencyMs: { type: 'number', description: '额外延迟（毫秒）' },
        downloadKbps: { type: 'number', description: '下行带宽（KB/s）' },
        uploadKbps: { type: 'number', description: '上行带宽（KB/s）' },
        offline: { type: 'boolean', description: '断网' },
        reset: { type: 'boolean', description: '恢复默认（无延迟、不限速、缓存可用）' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'a11y_tree',
    description: '读无障碍树：AI 看到的是「这是什么」（heading/link/button…），比读 DOM 省 token 且带语义。',
    inputSchema: {
      type: 'object',
      properties: {
        roles: { type: 'string', description: '只看这些角色，逗号分隔，如 heading,link,button' },
        limit: { type: 'number', description: '最多返回多少个有名字的节点，默认 60' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'css_coverage',
    description: '统计 CSS 规则使用率（重载后测量）：总规则数、用到/没用、按样式表分组。用来找死代码 CSS。',
    inputSchema: {
      type: 'object',
      properties: {
        reload: { type: 'boolean', description: '测量前是否重载页面，默认 true' },
        waitMs: { type: 'number', description: '重载后等待毫秒数，默认 3000' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'emulate_media',
    description: '模拟媒体特性：深色/浅色、打印、减少动效、强制色彩。用来一次抓多态样式。',
    inputSchema: {
      type: 'object',
      properties: {
        scheme: { type: 'string', enum: ['dark', 'light'], description: 'prefers-color-scheme' },
        media: { type: 'string', description: '媒体类型，如 print' },
        reducedMotion: { type: 'string', enum: ['reduce', 'no-preference'] },
        forcedColors: { type: 'string', enum: ['active', 'none'] },
        reset: { type: 'boolean', description: '恢复默认' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'screenshot',
    description: '截图存盘（不往上下文塞 base64）：整页、当前视口或某个元素。返回文件绝对路径与字节数。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '只截这个元素' },
        fullPage: { type: 'boolean', description: '截整页（含视口外）' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'navigate',
    description: '打开某个地址：支持站内路径（如 /add）或完整 URL。会等页面 readyState 到 complete，再留一小段渲染时间。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '站内路径（/add）或完整 URL' },
        timeoutMs: { type: 'number', description: '最长等待，默认 12000' },
        settleMs: { type: 'number', description: 'readyState 完成后额外等待，默认 400' }
      },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'resize',
    description: '改视口尺寸（模拟手机/平板/桌面），可选重载，并顺带体检横向溢出和过小的点按目标。恢复默认用 reset。',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'number', description: '视口宽（CSS 像素）' },
        height: { type: 'number', description: '视口高' },
        mobile: { type: 'boolean', description: '按移动端模式渲染（触摸、视口 meta）' },
        deviceScaleFactor: { type: 'number', description: '像素比，默认 1' },
        reload: { type: 'boolean', description: '改完是否重载页面' },
        ignoreCache: { type: 'boolean', description: '重载时是否绕缓存' },
        waitMs: { type: 'number', description: '重载后等待毫秒，默认 2500' },
        reset: { type: 'boolean', description: '恢复默认视口' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'interact',
    description: '在页面上做一次交互并回报前后差值：scroll（滚到底可触发懒加载）、click、fill（填输入框，兼容 Vue/React 绑定）、select、press（Enter/Tab 等）。返回 URL / DOM / 文本 / 请求 / 日志的变化量。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['scroll', 'click', 'fill', 'select', 'press'] },
        selector: { type: 'string', description: 'CSS 选择器（首选）' },
        text: { type: 'string', description: '按可见文字定位（如按钮文案「Vue」）' },
        placeholder: { type: 'string', description: '按输入框 placeholder 定位' },
        value: { type: 'string', description: 'fill / select 用' },
        key: { type: 'string', description: 'press 用：Enter / Tab / Escape / ArrowDown / ArrowUp' },
        to: { type: 'string', enum: ['bottom', 'top'], description: 'scroll 方向，默认 bottom' },
        steps: { type: 'number', description: 'scroll 最多滚几屏，默认 15' },
        waitMs: { type: 'number', description: '每步等待，默认 450' },
        settleMs: { type: 'number', description: '动作后等待渲染，默认 900' }
      },
      required: ['action'],
      additionalProperties: false
    }
  },
  {
    name: 'net_mock',
    description: '拦截请求并返回伪造响应（Fetch 域）：mock 接口、改响应体、模拟错误状态码。用完记得 clear。',
    inputSchema: {
      type: 'object',
      properties: {
        urlPattern: { type: 'string', description: '正则字符串，匹配请求 URL，如 "/api/items"' },
        status: { type: 'number', description: 'HTTP 状态码，默认 200' },
        body: { type: 'string', description: '响应体' },
        headers: { type: 'object', description: '响应头' },
        clear: { type: 'boolean', description: '清空所有规则并关闭拦截' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'debugger_ctl',
    description: 'JS 调试：设置暂停于异常、在某行下断点、等待暂停并读调用栈、恢复/关闭。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['exceptions', 'break', 'wait', 'resume', 'off'] },
        state: { type: 'string', enum: ['none', 'uncaught', 'all'], description: 'exceptions 用' },
        urlRegex: { type: 'string', description: 'break 用，匹配脚本 URL' },
        lineNumber: { type: 'number', description: 'break 用，0 起算' },
        timeoutMs: { type: 'number', description: 'wait 用，默认 8000' },
        resume: { type: 'boolean', description: 'wait 拿到栈后是否自动恢复，默认 true' }
      },
      required: ['action'],
      additionalProperties: false
    }
  },
  {
    name: 'highlight',
    description: '在页面上高亮某个元素（Overlay 域），用来和人确认「你说的就是这块」。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        color: { type: 'string', description: '十六进制，如 #00b3ff' },
        clear: { type: 'boolean', description: '清除高亮' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'perf_metrics',
    description: '读性能指标：布局/样式重算次数与耗时、脚本耗时、堆内存、节点数。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'frames',
    description: '列出页面所有 frame 与子 target（iframe / worker / service worker），用来判断内容是不是在别的 frame 里。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
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
  recorder: recorder,
  net_conditions: netConditions,
  a11y_tree: a11yTree,
  css_coverage: cssCoverage,
  emulate_media: emulateMedia,
  screenshot: screenshot,
  navigate: navigate,
  resize: resize,
  interact: interact,
  net_mock: netMock,
  debugger_ctl: debuggerCtl,
  highlight: highlight,
  perf_metrics: perfMetrics,
  frames: frames
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
      // 调试器停在断点上时，任何 Runtime.evaluate 都不会返回，
      // 工具会一路挂到 15s 超时。除了 debugger_ctl，其它工具进来先自动恢复。
      if (name !== 'debugger_ctl' && pausedState && currentConn && currentConn.alive()) {
        try { await currentConn.send('Debugger.resume'); } catch {}
        pausedState = null;
        log('页面处于暂停态，已自动恢复以免阻塞');
      }
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
