// 只用 MCP 问页面：背景色 / 文字色 / 字体，以及背景色来自哪个 CSS 变量
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
  return new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej }); setTimeout(() => rej(new Error('timeout')), 20000); });
}
async function call(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  const t = (r.content || []).map(c => c.text).join('');
  if (r.isError) throw new Error(t);
  return JSON.parse(t);
}

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ask', version: '0' } });
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

const EXPR = `(() => {
  const bodyCS = getComputedStyle(document.body);
  const htmlCS = getComputedStyle(document.documentElement);
  const bg = bodyCS.backgroundColor;

  // 找出哪个 CSS 变量解析后等于这个背景色
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:-9999px;top:0;width:0;height:0';
  document.body.appendChild(probe);
  const asColor = v => { probe.style.color = ''; probe.style.color = v; return getComputedStyle(probe).color; };
  const looksColor = v => /^(#|rgb|hsl|oklch|oklab|lab|lch|color\\()/i.test(v);
  const target = asColor(bg);
  const vars = [];
  for (let i = 0; i < htmlCS.length; i++) {
    const n = htmlCS.item(i);
    if (!n.startsWith('--')) continue;
    const v = htmlCS.getPropertyValue(n).trim();
    if (!v || !looksColor(v)) continue;
    if (asColor(v) === target) vars.push(n);
  }
  probe.remove();

  return {
    主题: document.documentElement.getAttribute('data-theme') || '(无)',
    body背景: bg,
    html背景: htmlCS.backgroundColor,
    背景色来源变量: vars.slice(0, 4),
    文字色: bodyCS.color,
    正文字体: bodyCS.fontFamily.split(',')[0],
    正文字号: bodyCS.fontSize,
    body是渐变吗: bodyCS.backgroundImage === 'none' ? '否' : bodyCS.backgroundImage.slice(0, 80),
    关键区块背景: (() => {
      const out = {};
      [['header', '页头'], ['nav', '导航'], ['main', '主内容'], ['footer', '页脚'],
       ['.card, .post, article', '卡片/文章'], ['.hero', '首屏']].forEach(([sel, label]) => {
        const el = document.querySelector(sel);
        out[label] = el ? getComputedStyle(el).backgroundColor : '(无此元素)';
      });
      return out;
    })()
  };
})()`;

const r = await call('run_js', { expression: EXPR });
console.log('MCP 返回：');
console.log(r.value);

// 算对比度（WCAG），在 Node 侧算，过程透明
const m = String(r.value).match(/"body背景":\s*"rgba?\((\d+),\s*(\d+),\s*(\d+)/);
const t = String(r.value).match(/"文字色":\s*"rgba?\((\d+),\s*(\d+),\s*(\d+)/);
if (m && t) {
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = c => 0.2126 * lin(+c[1]) + 0.7152 * lin(+c[2]) + 0.0722 * lin(+c[3]);
  const L1 = lum(m), L2 = lum(t);
  const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
  console.log('\n背景 vs 文字 对比度：' + ratio.toFixed(2) + ':1');
  console.log('  WCAG AA 正文(≥4.5)  ' + (ratio >= 4.5 ? '通过' : '不通过'));
  console.log('  WCAG AA 大字(≥3.0)  ' + (ratio >= 3.0 ? '通过' : '不通过'));
  console.log('  WCAG AAA 正文(≥7.0) ' + (ratio >= 7 ? '通过' : '不通过'));
}
proc.kill();
