// 本地 HTTP 服务：给夹具提供真实的网络请求（含 200/404/500/慢请求）
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./fixture.html', import.meta.url), 'utf8');
const PORT = Number(process.env.PORT || 8799);

const server = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  if (p === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (p === '/api/items') return json(200, { ok: true, n: 42, items: [1, 2, 3] });
  if (p === '/api/save') {
    let b = '';
    req.on('data', d => { b += d; });
    req.on('end', () => json(200, { saved: true, bytes: b.length, echo: b }));
    return;
  }
  if (p === '/api/fail') return json(500, { error: 'boom', trace: 'E42' });
  if (p === '/api/big') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('x'.repeat(20000));
    return;
  }
  if (p === '/api/slow') {
    setTimeout(() => { res.writeHead(200); res.end('slow-ok'); }, 800);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => console.log('serving on http://127.0.0.1:' + PORT));
