#!/usr/bin/env node
// mcp_http_bridge.js — front a stdio MCP server over Streamable HTTP.
// Usage: node mcp_http_bridge.js <PORT> <BIN> [ARGS...]
//   PORT : HTTP port to serve on
//   BIN  : absolute path to the node MCP server's bin entry
//   ARGS : extra args passed to the server
//
// 2026-10-18 deep-check fixes:
//   * upstream JSON-RPC errors are now forwarded as proper `error`
//     responses (were masquerading as `result` — hid failures from the
//     client and defeated the framework's retry layer)
//   * child-exit watchdog: if the stdio server dies, the bridge exits
//     so Docker restarts the whole container (healthcheck only proved
//     the HTTP listener was alive, not the upstream)
//   * notifications/initialized is sent as a real notification (no id)
const { spawn } = require('child_process');
const http = require('http');

const port = parseInt(process.argv[2], 10);
const [bin, ...args] = process.argv.slice(3);
const child = spawn(bin, args, { stdio: ['pipe','pipe','inherit'], env: process.env });

let buf = '';
const pending = new Map();
let initialized = false;
let serverInfo = {};
let toolCache = null;
let nextId = 100;   // unique id per forwarded call - concurrent tools/call
                    // requests MUST NOT share ids or responses get lost

child.stdout.on('data', d => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const done = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error !== undefined) {
        done({ ok: false, value: msg.error });      // real upstream error
      } else {
        done({ ok: true, value: msg.result });
      }
    }
    // notifications from upstream (none expected) are ignored
  }
});

// watchdog: upstream gone -> take the bridge down with it -> Docker
// restarts the container (restart: unless-stopped). A live HTTP listener
// with a dead stdio server would otherwise black-hole every tool call
// until the 120s timeout.
child.on('exit', (code) => {
  console.error('bridge: upstream exited (' + code + ') - shutting down');
  process.exit(1);
});
child.on('error', (err) => {
  console.error('bridge: upstream spawn failed - ' + err.message);
  process.exit(1);
});

function rpc(id, method, params, signal) {
  return new Promise(resolve => {
    let timer = null;
    const settle = (value) => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal) signal.removeEventListener('abort', onAbort);
      pending.delete(id);
      resolve(value);
    };
    const onAbort = () => {
      if (pending.has(id)) {
        settle({ ok: false, value: { code: -32000, message: 'bridge: client aborted request' } });
      }
    };
    pending.set(id, (r) => { settle(r); });
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    child.stdin.write(payload);
    // upstream tools can take a while (deep searches, long shell commands)
    // - 15 min cap, and a proper JSON-RPC error instead of a garbage
    // timeout object. The per-tool timeout (exec_mcp.js timeout_ms) is
    // always lower than this, so the server always answers first.
    timer = setTimeout(() => {
      if (pending.has(id)) {
        settle({ ok: false, value: { code: -32000, message: 'bridge: upstream timeout' } });
      }
    }, 900000);
  });
}

function rpcNext(method, params, signal) {
  return rpc(nextId++, method, params, signal);
}

function init() {
  initialized = true;
  rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'http-bridge', version: '1' } })
    .then(res => {
      serverInfo = res.ok ? (res.value ?? {}) : {};
      // real notification: no id (an id would make it a request)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    });
}

init();

function sendResult(res, msg, r) {
  res.setHeader('content-type', 'application/json');
  const body = { jsonrpc: '2.0', id: msg.id };
  if (r.ok) body.result = r.value;
  else body.error = r.value;
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  // abort plumbing: if the client drops the request (timeout, cancel,
  // closed tab) we stop waiting on the upstream and free the pending
  // slot instead of leaking it until the 15 min cap.
  const abort = new AbortController();
  let responseDone = false;
  res.on('finish', () => { responseDone = true; });
  res.on('close', () => { if (!responseDone) abort.abort(); });
  req.on('aborted', () => abort.abort());
  if (req.method === 'GET' && (req.url === '/mcp' || req.url === '/')) {
    // SSE endpoint (no-op stream)
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': ok\n\n');
    return;
  }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    let msg;
    try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
    // Handle initialize
    if (msg.method === 'initialize') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'bridge-'+port, version: '1' }
      }}));
      return;
    }
    if (msg.method === 'notifications/initialized' || (msg.method && msg.id === undefined)) { res.end(); return; }
    // tools/list (cached; a failed fetch leaves the cache empty so the
    // next call retries instead of pinning an empty roster)
    if (msg.method === 'tools/list') {
      if (!toolCache) {
        const r = await rpc(2, 'tools/list', {});
        if (r.ok && r.value && r.value.tools) toolCache = r.value.tools;
      }
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({ jsonrpc:'2.0', id: msg.id, result: { tools: toolCache || [] } }));
      return;
    }
    // tools/call
    if (msg.method === 'tools/call') {
      const r = await rpcNext('tools/call', msg.params, abort.signal);
      sendResult(res, msg, r);
      return;
    }
    // ping
    if (msg.method === 'ping') { res.end(JSON.stringify({jsonrpc:'2.0', id: msg.id, result:{}})); return; }
    // forward anything else
    const r = await rpcNext(msg.method, msg.params ?? {}, abort.signal);
    sendResult(res, msg, r);
  });
});
// Idle keep-alive sockets: Node closes them after 5s by default, which
// races with the next request on a pooled connection and surfaces as an
// intermittent ReadTimeout / ECONNRESET on trivial calls. Keep them
// open well past the client idle window instead.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.on('clientError', (err, socket) => {
  // malformed/half-open connections must not kill the listener
  try {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
  } catch { /* socket already gone */ }
});
server.listen(port, '0.0.0.0', () => console.log('bridge', port, 'wrapping', bin, args.join(' ')));
