// 本地 HTTP + WebSocket 服务：给夹具提供真实网络请求与 WS 连接
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const html = readFileSync(new URL('./fixture.html', import.meta.url), 'utf8');
const PORT = Number(process.env.PORT || 8799);

const INNER = `<!doctype html>
<html><head><meta charset="utf-8"><title>inner-frame</title></head>
<body style="font:14px system-ui;padding:8px">
<h1 id="inner">inner content</h1>
<script>console.log('inner-console-marker');</script>
</body></html>`;

// ---- 最小 WebSocket 实现（只为测试 WebSocket 帧采集）
function wsAccept(key) {
  return createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function decodeFrames(buf) {
  const out = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const opcode = buf[off] & 0x0f;
    const masked = (buf[off + 1] & 0x80) === 0x80;
    let len = buf[off + 1] & 0x7f;
    let p = off + 2;
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let mask = null;
    if (masked) { if (p + 4 > buf.length) break; mask = buf.subarray(p, p + 4); p += 4; }
    if (p + len > buf.length) break;
    const data = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    if (opcode === 1) out.push(data.toString('utf8'));
    if (opcode === 8) break;
    off = p + len;
  }
  return out;
}

function sendText(socket, text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

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
  if (p === '/inner.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(INNER);
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

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'] || '';
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n'
  );
  socket.on('data', buf => {
    for (const msg of decodeFrames(buf)) sendText(socket, 'echo:' + msg);
  });
  socket.on('error', () => {});
});

server.listen(PORT, '127.0.0.1', () => console.log('serving on http://127.0.0.1:' + PORT));
