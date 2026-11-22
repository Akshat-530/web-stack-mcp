# Web-Stack MCP

**One MCP server that aggregates eight web & browser MCP servers — plus a built-in
API-key rotation relay — inside a single container.**

Connect your MCP client to **one** endpoint (`http://127.0.0.1:4032/mcp`) and get
**127 tools** covering search, scraping, crawling, a stealth browser, DevTools,
documentation lookup, TLS-fingerprint impersonation and more.

| Upstream | What it adds |
|---|---|
| **tavily** | best-in-class web search / research / crawl / map / extract |
| **firecrawl** | scraping + bot-protected crawl + agent + monitors + data providers |
| **context7** | versioned API/library documentation |
| **fatsearch** | free URL/PDF → compact markdown reader |
| **playwright** | headless Chromium automation + accessibility snapshots |
| **chrome** | Chrome DevTools: traces, network, CSS, Lighthouse, heap, screencast |
| **stealth** | undetectable (nodriver) browser for bot-protected pages |
| **scrapling** | TLS/JA3 + HTTP/3 fingerprint impersonation, session state save/load |

## Why

Instead of wiring eight MCP servers into your client (eight entries, eight ports,
eight sets of credentials), you point it at **one**. The container runs every
upstream on `127.0.0.1` and the aggregator re-exposes their merged tools, routing
each call to the right server.

Tavily, Firecrawl and Context7 **rotate API keys automatically** through an
in-container relay: hold a pool of keys, and on `401/403/429` the relay moves to
the next one — callers never see a rate limit and never hold a key.

## Quick start

```bash
git clone https://github.com/Akshat-530/web-stack-mcp.git
cd web-stack-mcp
cp .env.example .env      # add your keys / tokens
docker build -t web-stack:allinone .
docker run -d --name web-stack -p 127.0.0.1:4032:4032 --env-file .env web-stack:allinone
```

Or with the example compose file (uses the published image):

```bash
docker compose -f docker-compose.example.yml up -d
```

Then point your MCP client at `http://127.0.0.1:4032/mcp`.

## Configuration (`.env`)

```dotenv
# API key pools — comma-separated; rotated automatically
TAVILY_API_KEYS=key1,key2
FIRECRAWL_API_KEYS=key1,key2
CONTEXT7_API_KEYS=key1,key2
# Auth tokens for the browser upstreams
STEALTH_BROWSER_MCP_AUTH_TOKEN=change-me
SCRAPLING_MCP_AUTH_TOKEN=change-me
```

**Never commit `.env`** — it is in `.gitignore`.

### Choosing which tools are exposed

Edit `config/web-stack.config.example.json` (mount it at
`/data/web-stack/config.json`). Per upstream:

- `include` — allowlist of tool names (`[]` = all)
- `exclude` — denylist
- `prefix` — optional name prefix (`""` keeps names; collisions are auto-named `<label>__<tool>`)
- `enabled` — set `false` to drop an upstream

Then restart the container.

## Ports

Only `127.0.0.1:4032` is published. Everything else listens on `127.0.0.1`
inside the container:

| Service | Internal port |
|---|---|
| aggregator (MCP endpoint) | 4032 |
| key-rotation relay — tavily / firecrawl / context7 | 4016 / 4017 / 4022 |
| playwright / chrome / stealth | 4002 / 4003 / 4007 |
| firecrawl / tavily / context7 / fatsearch | 4008 / 4009 / 4023 / 4027 |
| scrapling | 4033 |

## Operations

```bash
docker exec web-stack supervisorctl status      # all upstreams + relays
docker logs -f web-stack
```

Every upstream is supervised and restarts on crash.

## Local helper tools

The aggregator adds three tools of its own:

- `web_stack_status` — per-upstream reachability and tool counts
- `web_stack_rotation` — key-rotation relay health (key count, calls) — never prints keys
- `web_stack_refresh` — re-read config + re-fetch upstream tool lists

## Security

- No API keys in the image, the repo or the config — keys live only in your `.env`
  and are injected at runtime.
- The MCP endpoint is published on loopback only by default.
- Rotating upstreams reach the internet through the in-container relay.

## License

MIT — see [LICENSE](LICENSE).

Upstream MCP servers, the stealth browser and Scrapling keep their own licenses;
this project only orchestrates them.
