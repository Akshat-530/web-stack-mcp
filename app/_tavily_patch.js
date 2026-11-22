// Idempotent startup patch: make tavily-mcp honor TAVILY_API_BASE_URL.
// Runs before the MCP bridge; safe to run repeatedly.
const fs = require('fs');
const P = '/usr/lib/node_modules/tavily-mcp/build/index.js';
let s = fs.readFileSync(P, 'utf8');

if (!s.includes('TAVILY_API_BASE_URL')) {
  const anchor = 'const API_KEY = process.env.TAVILY_API_KEY;';
  const add = anchor +
    "\nconst API_BASE_URL = (process.env.TAVILY_API_BASE_URL || 'https://api.tavily.com').replace(/\\/+$/, '');";
  s = s.replace(anchor, add);
  for (const k of ['search', 'extract', 'crawl', 'map', 'research']) {
    s = s.replace("'https://api.tavily.com/" + k + "'", "`${API_BASE_URL}/" + k + "`");
  }
  fs.writeFileSync(P, s);
  console.error('[tavily-patch] applied base-url override');
} else {
  console.error('[tavily-patch] already patched');
}