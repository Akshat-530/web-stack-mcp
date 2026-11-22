#!/usr/bin/env node
/* web_stack_mcp.js - Web-Stack: ONE MCP server that aggregates several HTTP MCP
 * servers (tavily, firecrawl, context7, fatsearch, playwright, chrome, stealth)
 * into a single stdio MCP server. Fronted by /app/mcp_http_bridge.js.
 *
 * Config: WEBSTACK_CONFIG (default /data/web-stack/config.json)
 *   { "server": {"name","version"},
 *     "upstreams": [ {"name","label","url","token"?, "tokenEnv"?,
 *                     "prefix"?:"", "include"?:[], "exclude"?:[], "description"?} ] }
 *   include = allowlist of ORIGINAL tool names ([] = all)
 *   exclude = denylist of ORIGINAL tool names
 *   prefix  = optional name prefix; "" keeps original names and only
 *             disambiguates collisions as "<label>__<tool>".
 *
 * Local tools added: web_stack_status, web_stack_refresh
 */
'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');

const CONFIG_PATH = process.env.WEBSTACK_CONFIG || '/data/web-stack/config.json';
const TIMEOUT_MS  = parseInt(process.env.WEBSTACK_TIMEOUT_MS || '900000', 10);
const log = (...a) => process.stderr.write('[web-stack] ' + a.join(' ') + '\n');
process.on('unhandledRejection', e => log('unhandledRejection: ' + (e && e.message || e)));

let nextId = 1000;
let serverName = 'Web-Stack';
let serverVersion = '1.0.0';
let keyProxyCfg = null;
const upstreams = new Map();   // name -> Upstream
let route = new Map();         // exposedName -> { up, originalName }

function readConfig() { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }

function httpPost(url, body, headers, timeoutMs) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ error: 'bad url ' + url }); }
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body));
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: Object.assign({
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream',
        'content-length': data.length
      }, headers || {})
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', e => resolve({ error: e.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ error: 'timeout after ' + timeoutMs + 'ms' }); });
    req.write(data); req.end();
  });
}

function httpGet(url, timeoutMs) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ error: 'bad url' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({ protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'GET' }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(c).toString('utf8') }));
    });
    req.on('error', e => resolve({ error: e.message }));
    req.setTimeout(timeoutMs || 15000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });
}

// Parse a JSON-RPC reply from either a plain-JSON bridge or a Streamable-HTTP
// server (SSE-framed `data:` lines).
function parseRpcBody(text) {
  if (!text) return null;
  if (text.includes('data:')) {
    const m = [...text.matchAll(/^data:\s*(.+)$/gm)];
    for (let i = m.length - 1; i >= 0; i--) { try { return JSON.parse(m[i][1]); } catch (e) { /* keep scanning */ } }
  }
  try { return JSON.parse(text); } catch (e) { return null; }
}

class Upstream {
  constructor(cfg) { this.cfg = cfg; this.sessionId = null; this.tools = []; this.ok = false; this.err = null; this.ready = null; }

  headers() {
    const h = {};
    const tok = this.cfg.tokenEnv ? (process.env[this.cfg.tokenEnv] || '') : (this.cfg.token || '');
    if (tok) h['authorization'] = 'Bearer ' + String(tok).replace(/[\r\n]+/g, '').trim();
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    return h;
  }

  async rpc(method, params) {
    return httpPost(this.cfg.url, { jsonrpc: '2.0', id: nextId++, method, params: params || {} }, this.headers(), TIMEOUT_MS);
  }

  async connect() {
    this.sessionId = null;
    const r = await httpPost(this.cfg.url,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'web-stack', version: serverVersion } } },
      this.headers(), TIMEOUT_MS);
    if (r.error) { this.ok = false; this.err = r.error; return; }
    if (r.status !== 200) { this.ok = false; this.err = 'initialize HTTP ' + r.status; return; }
    const sid = r.headers && (r.headers['mcp-session-id'] || r.headers['Mcp-Session-Id']);
    if (sid) this.sessionId = sid;
    await httpPost(this.cfg.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, this.headers(), 15000);
    await this.refreshTools();
  }

  async refreshTools() {
    const r = await this.rpc('tools/list', {});
    if (r.error) { this.ok = false; this.err = r.error; return; }
    const p = parseRpcBody(r.text);
    const tools = p && p.result && Array.isArray(p.result.tools) ? p.result.tools : null;
    if (!tools) {
      if (this.sessionId && (r.status === 400 || r.status === 404)) { await this.connect(); return; }
      this.ok = false; this.err = 'no tools (HTTP ' + r.status + ')'; return;
    }
    this.tools = tools; this.ok = true; this.err = null;
  }

  async call(originalName, args) {
    let r = await this.rpc('tools/call', { name: originalName, arguments: args || {} });
    if (r.error && this.sessionId) { await this.connect(); r = await this.rpc('tools/call', { name: originalName, arguments: args || {} }); }
    const p = parseRpcBody(r.text);
    if (p && (p.result !== undefined || p.error !== undefined)) return p;
    return { error: { code: -32000, message: this.cfg.name + ': ' + (r.error || ('HTTP ' + (r && r.status))) } };
  }
}

async function reconcile() {
  let cfg;
  try { cfg = readConfig(); } catch (e) { log('config read failed: ' + e.message); return; }
  if (cfg.server) { serverName = cfg.server.name || serverName; serverVersion = cfg.server.version || serverVersion; }
  if (cfg.keyProxy) keyProxyCfg = cfg.keyProxy;
  const seen = new Set();
  for (const u of (cfg.upstreams || [])) {
    if (u.enabled === false) continue;   // explicitly disabled -> treated as absent
    seen.add(u.name);
    let up = upstreams.get(u.name);
    const tokChanged = up && (up.cfg.tokenEnv || up.cfg.token || '') !== (u.tokenEnv || u.token || '');
    if (!up || up.cfg.url !== u.url || tokChanged) {
      up = new Upstream(u);
      upstreams.set(u.name, up);
      up.ready = up.connect().then(() => log(u.name + ': ' + (up.ok ? up.tools.length + ' tools' : 'FAILED - ' + up.err))).catch(e => log(u.name + ' connect: ' + e.message));
    } else {
      up.cfg = u;   // pick up filter/prefix/label edits live
    }
  }
  for (const name of [...upstreams.keys()]) if (!seen.has(name)) { upstreams.delete(name); log('dropped upstream ' + name); }
  // wait for any in-flight connects so tools/list never reports a half-built roster
  await Promise.allSettled([...upstreams.values()].map(x => x.ready).filter(Boolean));
}

// Build the exposed tool table applying per-upstream include/exclude/prefix.
function build() {
  const raw = [];
  const counts = {};
  for (const up of upstreams.values()) {
    if (!up.ok) continue;
    const inc = up.cfg.include || [], exc = up.cfg.exclude || [];
    const prefix = up.cfg.prefix || '';
    for (const t of up.tools) {
      if (inc.length && inc.indexOf(t.name) === -1) continue;
      if (exc.length && exc.indexOf(t.name) !== -1) continue;
      const base = prefix ? prefix + '__' + t.name : t.name;
      counts[base] = (counts[base] || 0) + 1;
      raw.push({ up: up, originalName: t.name, base: base, schema: t });
    }
  }
  const used = new Set();
  route = new Map();
  const tools = [];
  for (const e of raw) {
    let name = e.base;
    if (counts[e.base] > 1 || used.has(name)) name = (e.up.cfg.label || e.up.cfg.name) + '__' + e.originalName;
    used.add(name);
    const s = e.schema;
    const out = { name: name, description: s.description || '' };
    out.inputSchema = s.inputSchema || { type: 'object', properties: {} };
    if (s.annotations) out.annotations = s.annotations;
    tools.push(out);
    route.set(name, { up: e.up, originalName: e.originalName });
  }
  return tools;
}

const LOCAL_TOOLS = [
  { name: 'web_stack_status', description: 'Report Web-Stack aggregation status: each upstream (tavily, firecrawl, context7, fatsearch, playwright, chrome, stealth), reachability, tool counts and any error, plus the local tools.', inputSchema: { type: 'object', properties: {} } },
  { name: 'web_stack_refresh', description: 'Re-fetch the tool lists from all upstreams and reload the Web-Stack config (include/exclude/prefix).', inputSchema: { type: 'object', properties: {} } },
  { name: 'web_stack_rotation', description: 'Report the MCP key-rotation relay (key-proxy) health for the rotating upstreams: tavily, firecrawl, context7 - key count, rotations and call totals per relay (no secrets).', inputSchema: { type: 'object', properties: {} } }
];

async function localCall(name) {
  if (name === 'web_stack_status') {
    const st = [];
    for (const up of upstreams.values()) {
      let exposed = 0;
      if (up.ok) {
        const inc = up.cfg.include || [], exc = up.cfg.exclude || [];
        for (const t of up.tools) { if (inc.length && inc.indexOf(t.name) === -1) continue; if (exc.length && exc.indexOf(t.name) !== -1) continue; exposed++; }
      }
      st.push({ name: up.cfg.name, label: up.cfg.label, url: up.cfg.url, ok: up.ok, upstreamTools: up.tools.length, exposed: exposed, error: up.err });
    }
    return { content: [{ type: 'text', text: JSON.stringify({ server: serverName, version: serverVersion, exposedTools: route.size, localTools: LOCAL_TOOLS.length, upstreams: st }, null, 2) }] };
  }
  if (name === 'web_stack_rotation') {
    const kp = keyProxyCfg || {};
    const base = kp.base || 'http://key-proxy';
    const relays = kp.relays || {};
    const rows = [];
    for (const svc of Object.keys(relays)) {
      const port = relays[svc];
      const r = await httpGet(base + ':' + port + '/health', 8000);
      let h = null; try { h = r.text ? JSON.parse(r.text) : null; } catch (e) {}
      rows.push({ service: svc, port: port, ok: !!(h && h.ok), keys: h ? h.keys : null, rotations: h ? h.rotations : null, calls: h ? h.calls : null, upstream: h ? h.upstream : null, error: r.error || null });
    }
    return { content: [{ type: 'text', text: JSON.stringify({ keyProxy: base, relays: rows }, null, 2) }] };
  }
  if (name === 'web_stack_refresh') {
    await reconcile();
    for (const up of upstreams.values()) if (up.ok) await up.refreshTools();
    const tools = build();
    return { content: [{ type: 'text', text: 'Refreshed. Exposed tools: ' + tools.length }] };
  }
  return { isError: true, content: [{ type: 'text', text: 'unknown local tool ' + name }] };
}

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

async function handle(msg) {
  if (msg.id === undefined || msg.id === null) return;  // notification -> no reply
  const id = msg.id;
  try {
    if (msg.method === 'initialize') {
      return out({ jsonrpc: '2.0', id: id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: serverName, version: serverVersion } } });
    }
    if (msg.method === 'ping') return out({ jsonrpc: '2.0', id: id, result: {} });
    if (msg.method === 'tools/list') {
      await reconcile();
      const tools = build().concat(LOCAL_TOOLS);
      return out({ jsonrpc: '2.0', id: id, result: { tools: tools } });
    }
    if (msg.method === 'tools/call') {
      const name = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      if (name === 'web_stack_status' || name === 'web_stack_refresh' || name === 'web_stack_rotation') {
        const r = await localCall(name);
        return out({ jsonrpc: '2.0', id: id, result: r });
      }
      if (route.size === 0) { await reconcile(); build(); }
      const entry = route.get(name);
      if (!entry) return out({ jsonrpc: '2.0', id: id, error: { code: -32602, message: 'unknown tool: ' + name + ' (call web_stack_status to list upstreams)' } });
      const r = await entry.up.call(entry.originalName, args);
      if (r && r.error !== undefined) return out({ jsonrpc: '2.0', id: id, error: r.error });
      return out({ jsonrpc: '2.0', id: id, result: (r && r.result !== undefined) ? r.result : r });
    }
    return out({ jsonrpc: '2.0', id: id, error: { code: -32601, message: 'method not supported: ' + msg.method } });
  } catch (e) {
    log('handler error: ' + (e && e.stack || e));
    return out({ jsonrpc: '2.0', id: id, error: { code: -32000, message: String(e && e.message || e) } });
  }
}

// stdio loop: newline-delimited JSON-RPC, processed strictly in order.
let buf = '';
let chain = Promise.resolve();
process.stdin.on('data', d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
    chain = chain.then(() => handle(msg)).catch(e => log('chain: ' + e.message));
  }
});
process.stdin.on('end', () => { log('stdin closed'); process.exit(0); });

log('starting; config=' + CONFIG_PATH);
reconcile().then(() => log('initial sync: ' + [...upstreams.values()].map(u => u.cfg.name + (u.ok ? '(' + u.tools.length + ')' : '!')).join(' ')));
