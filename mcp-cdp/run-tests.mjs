// 总跑器：起夹具服务与 headless Chrome，跑全部套件并汇总
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const FIXTURE_PORT = process.env.FIXTURE_PORT || '8799';
const CDP_PORT = process.env.CDP_PORT || '9223';
const EP = `http://127.0.0.1:${CDP_PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CHROME = process.env.CHROME_PATH || [
  join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].find(p => p && existsSync(p));

if (!CHROME) { console.error('找不到 Chrome，可用 CHROME_PATH 指定'); process.exit(1); }

const fixtures = ['transport', 'capabilities', 'service', 'concurrency-5', 'concurrency-12'];
const only = process.argv.slice(2).filter(a => !a.startsWith('-'));
const todo = only.length ? fixtures.filter(f => only.includes(f)) : fixtures;

let serveProc = null, chromeProc = null;
let profile = null;

function cleanup() {
  try { if (chromeProc) chromeProc.kill(); } catch {}
  try { if (serveProc) serveProc.kill(); } catch {}
}

// 每个套件用一台全新的 Chrome：套件之间不会互相污染（多标签、mock、媒体模拟、缓冲）
async function startChrome() {
  profile = join(process.env.TEMP || '/tmp', `pe-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  chromeProc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1280,800', `http://127.0.0.1:${FIXTURE_PORT}/`
  ], { stdio: 'ignore' });
  return waitFor(`${EP}/json/version`);
}

function stopChrome() {
  try { if (chromeProc) chromeProc.kill(); } catch {}
  chromeProc = null;
  // 等端口真正释放，否则下一个套件可能连到正在关闭的实例
  return sleep(600);
}

async function waitFor(url, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await sleep(250);
  }
  return false;
}

function runSuite(file, extraEnv, timeoutMs = 180000) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [join(DIR, file)], {
      cwd: DIR,
      env: { ...process.env, CDP_ENDPOINT: EP, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('exit', code => {
      clearTimeout(timer);
      const m = out.match(/RESULT (\{[^\n]*\})/);
      if (!m) return resolve({ suite: file, code, total: 0, pass: 0, fail: 1, error: (err || out).slice(-400) });
      const j = JSON.parse(m[1]);
      resolve({ suite: j.suite || file, code, total: j.total, pass: j.pass, fail: j.fail });
    });
  });
}

try {
  // 夹具服务
  serveProc = spawn(process.execPath, [join(DIR, 'serve.mjs')], {
    cwd: DIR, env: { ...process.env, PORT: FIXTURE_PORT }, stdio: 'ignore'
  });
  if (!await waitFor(`http://127.0.0.1:${FIXTURE_PORT}/`)) throw new Error('夹具服务没起来');

  console.log(`夹具 http://127.0.0.1:${FIXTURE_PORT}/   调试 ${EP}\n`);

  const plan = {
    transport: ['test-client.mjs', {}],
    capabilities: ['capabilities-test.mjs', {}],
    service: ['suite-service.mjs', {}],
    'concurrency-5': ['concurrency-test.mjs', { N: '5' }],
    'concurrency-12': ['concurrency-test.mjs', { N: '12' }]
  };

  const results = [];
  for (const key of todo) {
    const [file, env] = plan[key];
    process.stdout.write(`  ${key.padEnd(16)}启动浏览器…\r`);
    if (!await startChrome()) throw new Error('Chrome 调试端口没起来（' + key + '）');
    const r = await runSuite(file, env);
    await stopChrome();
    results.push({ key, ...r });
    const line = r.error
      ? `  ${key.padEnd(16)}✗ 执行失败  ${r.error.split('\n')[0].slice(0, 80)}`
      : `  ${key.padEnd(16)}${r.fail === 0 ? '✓' : '✗'}  ${String(r.pass).padStart(3)}/${String(r.total).padEnd(3)} 通过${r.fail ? `，失败 ${r.fail}` : ''}`;
    console.log(line.padEnd(76));
  }

  const total = results.reduce((s, r) => s + r.total, 0);
  const pass = results.reduce((s, r) => s + r.pass, 0);
  const fail = results.reduce((s, r) => s + r.fail, 0);

  console.log('\n' + '─'.repeat(60));
  console.log(`  合计：${pass}/${total} 通过${fail ? `，${fail} 条失败` : ''}`);
  console.log('─'.repeat(60));

  cleanup();
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error('\n启动失败：', e.message);
  cleanup();
  process.exit(1);
}
