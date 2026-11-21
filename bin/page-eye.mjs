#!/usr/bin/env node
// page-eye 入口。
//
// 默认行为是「MCP 服务器」：走 stdio，stdout 只留 JSON-RPC，人类可读的输出全部走 stderr。
// 其余模式（--doctor / --print-config / --launch）是给人用的，才往 stdout 写东西。

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PKG_REPO = 'github:Raywh/page-eye';
const args = process.argv.slice(2);

const say = (...a) => console.error('[page-eye]', ...a);

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : undefined;
}

const port = Number(flag('--port') || process.env.CDP_PORT || 9222);
const endpoint = flag('--endpoint') || process.env.CDP_ENDPOINT || `http://127.0.0.1:${port}`;

const CHROME_CANDIDATES = [
  process.env.PAGE_EYE_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);

function findChrome() {
  return CHROME_CANDIDATES.find(p => { try { return existsSync(p); } catch { return false; } }) || null;
}

async function fetchJson(url, timeoutMs = 2000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function probe() {
  try {
    const v = await fetchJson(endpoint + '/json/version');
    const list = await fetchJson(endpoint + '/json/list');
    const pages = list.filter(t => t.type === 'page');
    return { up: true, version: v, pages };
  } catch (e) {
    return { up: false, error: e.message };
  }
}

function printConfig() {
  // npx 形式：不用 clone、不用绝对路径，升级只需清 npx 缓存
  const cfg = {
    mcpServers: {
      'page-eye': {
        command: 'npx',
        args: ['-y', PKG_REPO],
        env: { CDP_ENDPOINT: endpoint }
      }
    }
  };
  process.stdout.write(JSON.stringify(cfg, null, 2) + '\n');
}

async function doctor() {
  const lines = [];
  const major = Number(process.versions.node.split('.')[0]);
  lines.push(`node        : v${process.versions.node}${major >= 20 ? '  ✓' : '  ✗ 需要 >= 20'}`);

  const chrome = findChrome();
  lines.push(`chrome      : ${chrome || '没找到（用 --chrome 指定，或自己启动）'}`);

  const p = await probe();
  if (p.up) {
    lines.push(`调试端口    : ${endpoint}  ✓  ${p.version.Browser || 'Chrome'}`);
    lines.push(`可操作标签  : ${p.pages.length} 个`);
    for (const t of p.pages.slice(0, 5)) {
      lines.push(`  - ${String(t.url).slice(0, 80)}`);
    }
    if (!p.pages.length) lines.push('  （没有 page 类型标签，先在浏览器里开一个网页）');
  } else {
    lines.push(`调试端口    : ${endpoint}  ✗  ${p.error}`);
    lines.push('  先启动 Chrome（保持已登录的 profile 也行）：');
    lines.push('    page-eye --launch');
    lines.push(`    或 chrome --remote-debugging-port=${port} --user-data-dir=<某目录>`);
  }

  lines.push('');
  lines.push('下一步：把这条命令的输出贴进 MCP 配置 —— `page-eye --print-config`');
  process.stdout.write(lines.join('\n') + '\n');
}

async function launch() {
  const chrome = flag('--chrome') || findChrome();
  if (!chrome) {
    say('没找到 Chrome，用 --chrome <路径> 指定');
    process.exit(1);
  }
  const before = await probe();
  if (before.up) {
    say(`${endpoint} 已经在跑，直接用`);
    process.exit(0);
  }
  const profile = flag('--profile') || mkdtempSync(path.join(tmpdir(), 'page-eye-profile-'));
  const child = spawn(chrome, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check'
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  const until = Date.now() + 20000;
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 400));
    const p = await probe();
    if (p.up) {
      say(`已启动：${p.version.Browser}`);
      say(`profile: ${profile}`);
      say(`endpoint: ${endpoint}`);
      process.exit(0);
    }
  }
  say('等了 20s 端口还没起来，手动跑一次看报错');
  process.exit(1);
}

function usage() {
  process.stdout.write(`page-eye — 让 AI 读懂你浏览器里那个页面

用法:
  page-eye                  以 MCP 服务器方式运行（stdio，给 MCP 客户端调用）
  page-eye --doctor         体检：node 版本、Chrome、调试端口、可用标签
  page-eye --print-config   打印 MCP 配置 JSON
  page-eye --launch         用临时 profile 启动一个可调试的 Chrome

选项:
  --port <n>        调试端口，默认 9222
  --endpoint <url>  完整端点，默认 http://127.0.0.1:<port>
  --chrome <path>   指定 Chrome 可执行文件
  --profile <dir>   --launch 用的 profile 目录
`);
}

// ---- 分发
if (args.includes('--help') || args.includes('-h')) {
  usage();
} else if (args.includes('--print-config')) {
  printConfig();
} else if (args.includes('--doctor')) {
  await doctor();
} else if (args.includes('--launch')) {
  await launch();
} else {
  process.env.CDP_ENDPOINT = endpoint;
  await import('../mcp-cdp/server.mjs');
}
