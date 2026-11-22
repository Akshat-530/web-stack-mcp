"""Generic API key-rotation proxy - lives in the MCP stack's `key-proxy` container.

One script, one instance per service:

    python key_rotate_proxy.py tavily     -> :4016  upstream api.tavily.com
    python key_rotate_proxy.py firecrawl  -> :4017  upstream api.firecrawl.dev

The MCP fleet reaches these relays as http://key-proxy:<port>; they have no
dependency on the Model_Providers container.

Each instance holds a POOL of keys from env. Every request gets the active
key injected as `Authorization: Bearer <key>`; on 401/403/429/432 the
proxy rotates to the next key and retries transparently. Callers never
hold keys and never see a rate limit.

Service config table:
    tavily     keys=TAVILY_API_KEYS       port=TAVILY_PROXY_PORT (4016)
               allow /search /extract /crawl /map /research
               strip body field "api_key" (tavily MCP injects a dummy)
    firecrawl  keys=FIRECRAWL_API_KEYS    port=FIRECRAWL_PROXY_PORT (4017)
               allow prefix /v2/*  (MCP calls /v2/scrape, /v2/search, ...)
    context7   keys=CONTEXT7_API_KEYS     port=CONTEXT7_PROXY_PORT (4022)
               allow prefix /v2/*  (MCP calls /v2/libs/search, /v2/context,
               ...; MCP points here via CONTEXT7_API_URL)

GET /health on each port -> {ok, keys, current, rotations, calls}
"""
from __future__ import annotations

import asyncio
import os
import sys
import threading

import httpx
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
import json

from collections import OrderedDict

from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

SERVICES = {
    "tavily": {
        "port_env": "TAVILY_PROXY_PORT", "port": 4016,
        "keys_env": "TAVILY_API_KEYS",
        "upstream": "https://api.tavily.com",
        "allow_paths": {"/search", "/extract", "/crawl", "/map", "/research"},
        "allow_prefix": None,
        "strip_body_key": "api_key",
    },
    "firecrawl": {
        "port_env": "FIRECRAWL_PROXY_PORT", "port": 4017,
        "keys_env": "FIRECRAWL_API_KEYS",
        "upstream": "https://api.firecrawl.dev",
        "allow_paths": None,
        "allow_prefix": "/v2/",   # scrape, search, crawl, crawl-status, map, extract, ...
        "strip_body_key": None,
    },
    "tokenharbour": {
        "port_env": "TOKENHARBOUR_PROXY_PORT", "port": 4021,
        "keys_env": "TOKENHARBOUR_API_KEYS",
        # Token Harbor gateway (OpenAI-compatible, https://tokenharbor.ai/v1).
        # LLM traffic: streaming pass-through; 429s are per-key rolling
        # free-allowance limits, so rotation spreads load across keys.
        "upstream": "https://tokenharbor.ai/v1",
        "allow_paths": {"/chat/completions", "/completions", "/models",
                        "/embeddings"},
        "allow_prefix": "/models/",   # /models/{id}
        "strip_body_key": None,
        "stream_mode": True,
    },
    "context7": {
        "port_env": "CONTEXT7_PROXY_PORT", "port": 4022,
        "keys_env": "CONTEXT7_API_KEYS",
        # Context7 docs API (API base is https://context7.com/api). The MCP
        # sends `Authorization: Bearer <key>`; this relay replaces it with a
        # rotated ctx7sk-* key, exactly like firecrawl. The MCP is pointed at
        # the relay with CONTEXT7_API_URL.
        "upstream": "https://context7.com/api",
        "allow_paths": None,
        "allow_prefix": "/v2/",   # /v2/libs/search, /v2/context, /v2/auth/check, /v2/feedback
        "strip_body_key": None,
    },
    "zro": {
        "port_env": "ZRO_PROXY_PORT", "port": 4030,
        "keys_env": "ZRO_API_KEYS",
        # Zro / MoonMath private inference (OpenAI-compatible, https://zro.moonmath.ai/v1).
        # Free tier caps concurrency at 2 in-flight requests PER KEY (hard 429),
        # so rotation is what spreads agent traffic across the pool.
        "upstream": "https://zro.moonmath.ai/v1",
        "allow_paths": {"/chat/completions", "/completions", "/models",
                        "/responses", "/messages"},
        "allow_prefix": "/models/",
        "strip_body_key": None,
        "stream_mode": True,
    },
    "gemini": {
        "port_env": "GEMINI_PROXY_PORT", "port": 4019,
        "keys_env": "GEMINI_API_KEYS",
        # Google AI Studio, OpenAI-compatible surface
        "upstream": "https://generativelanguage.googleapis.com/v1beta/openai",
        # Gemini 3 requirement: replayed tool calls must carry their
        # thought_signature (extra_content.google.*); OpenAI-compat clients
        # drop it - the proxy caches + reattaches it (HelixML pattern)
        "sig_repair": True,
        "allow_paths": {"/chat/completions", "/completions", "/models",
                         "/embeddings"},
        "allow_prefix": "/models/",   # /models/{id}
        "strip_body_key": None,
        "stream_mode": True,
    },
}
ROTATE_CODES = {401, 403, 429, 432}
# Some providers reject bad keys with 400 + a message (e.g. Google:
# "Invalid Auth key."). Rotate on 400 ONLY when the body says auth.
ROTATE_HINTS = ("invalid auth key", "api key not valid", "invalid api key",
                "unauthenticated", "api_key_invalid", "api key invalid")
DEBUG = os.environ.get("KEY_PROXY_DEBUG", "1") == "1"

_service = sys.argv[1] if len(sys.argv) > 1 else "tavily"
_cfg = SERVICES.get(_service)
if _cfg is None:
    raise SystemExit(f"unknown service: {_service} (known: {', '.join(SERVICES)})")

UPSTREAM = os.environ.get("KEY_PROXY_UPSTREAM", _cfg["upstream"])
PORT = int(os.environ.get(_cfg["port_env"], str(_cfg["port"])))
_keys = [k.strip() for k in os.environ.get(_cfg["keys_env"], "").split(",") if k.strip()]
_idx = 0
_rotations = 0
_total = 0
_lock = threading.Lock()

_FWD_ALLOW = {"content-type", "accept", "user-agent", "accept-language"}
_DROP_RESP = {"content-encoding", "transfer-encoding", "connection", "content-length"}


# Shared pooled client - MUST outlive StreamingResponse body iteration
# (a per-request `async with` client closes before Starlette drains the
# stream, truncating larger responses mid-body).
_shared_client = None


def _get_client():
    global _shared_client
    if _shared_client is None:
        # per-service: LLM chat streams pause for minutes during long
        # reasoning (no per-read limit; the framework's BG_TIMEOUT
        # bounds the total) - REST APIs keep a bounded read so a
        # stalled upstream cannot wedge the tool call
        if _cfg.get("stream_mode"):
            _t = httpx.Timeout(connect=20.0, read=None,
                               write=60.0, pool=60.0)
        else:
            _t = httpx.Timeout(connect=20.0, read=180.0,
                               write=60.0, pool=60.0)
        _shared_client = httpx.AsyncClient(
            timeout=_t,
            follow_redirects=True,
        )
    return _shared_client


# ---- Gemini thought-signature repair -------------------------------
# Gemini 3.x returns an encrypted thought signature on every function
# call (tool_calls[].extra_content.google.thought_signature in the
# OpenAI-compat format) and REQUIRES it back when the conversation
# history is replayed - a missing signature is a 400 INVALID_ARGUMENT.
# OpenAI-compat clients (langchain/openai SDK/litellm passthrough) drop
# the field, so the proxy caches signatures by tool_call id and
# reattaches them on the next request.
_SIG_CACHE: "OrderedDict[str, str]" = OrderedDict()


def _sig_remember(sid: str, sig: str) -> None:
    _SIG_CACHE[sid] = sig
    while len(_SIG_CACHE) > 512:
        _SIG_CACHE.popitem(last=False)


def _extract_sigs(obj) -> None:
    """Cache every tool-call thought signature found in an OpenAI-format
    response/delta object (works for full responses and SSE chunks)."""
    try:
        for ch in (obj.get("choices") or []):
            msg = ch.get("message") or ch.get("delta") or {}
            for tc in (msg.get("tool_calls") or []):
                sid = tc.get("id")
                sig = ((tc.get("extra_content") or {})
                       .get("google") or {}).get("thought_signature")
                if sid and sig:
                    _sig_remember(sid, sig)
    except Exception:
        pass


def _patch_request_sig(raw: bytes) -> bytes:
    """Reattach cached thought signatures to replayed assistant tool calls
    before forwarding to Gemini."""
    try:
        body = json.loads(raw) if raw else None
        if not isinstance(body, dict):
            return raw
        changed = False
        for msg in (body.get("messages") or []):
            if msg.get("role") != "assistant":
                continue
            for tc in (msg.get("tool_calls") or []):
                sid = tc.get("id")
                if not sid or sid not in _SIG_CACHE:
                    continue
                ec = tc.setdefault("extra_content", {})
                g = ec.setdefault("google", {})
                if not g.get("thought_signature"):
                    g["thought_signature"] = _SIG_CACHE[sid]
                    changed = True
        if changed:
            _log("sig_repair: reattached thought signature(s) "
                 f"({len(_SIG_CACHE)} cached)")
            return json.dumps(body).encode()
    except Exception:
        pass
    return raw


def _log(msg: str) -> None:
    if DEBUG:
        print(f"[{_service}-proxy] {msg}", flush=True)


def _current_key() -> str:
    with _lock:
        return _keys[_idx] if _keys else ""


def _rotate() -> str:
    global _idx, _rotations
    with _lock:
        if not _keys:
            return ""
        _idx = (_idx + 1) % len(_keys)
        _rotations += 1
        return _keys[_idx]


def _allowed(path: str) -> bool:
    if _cfg["allow_paths"] and path in _cfg["allow_paths"]:
        return True
    if _cfg["allow_prefix"] and path.startswith(_cfg["allow_prefix"]):
        return True
    return False


async def _proxy(request: Request) -> Response:
    global _total
    path = request.url.path
    if path == "/health":
        with _lock:
            return JSONResponse({
                "ok": bool(_keys), "keys": len(_keys), "current": _idx,
                "rotations": _rotations, "calls": _total, "upstream": UPSTREAM,
            })

    if not _allowed(path):
        _log(f"reject {path} (not an allowed endpoint)")
        return JSONResponse({"error": f"not an allowed endpoint: {path}"},
                            status_code=404)

    raw = await request.body()
    fwd_headers = {k.lower(): v for k, v in request.headers.items()
                   if k.lower() in _FWD_ALLOW}
    fwd_headers["content-type"] = "application/json"

    strip_key = _cfg["strip_body_key"]
    if strip_key:
        try:
            import json as _json
            _body = _json.loads(raw) if raw else {}
            if isinstance(_body, dict) and _body.pop(strip_key, None) is not None:
                raw = _json.dumps(_body).encode()
                _log(f"stripped {strip_key} from request body")
        except Exception:
            pass

    if _cfg.get("sig_repair"):
        raw = _patch_request_sig(raw)

    query = request.url.query
    url = UPSTREAM + path + (f"?{query}" if query else "")
    attempts = max(1, len(_keys))
    last_resp = None
    with _lock:
        _total += 1
        call_no = _total
    _log(f"call#{call_no} {request.method} {path} -> {url}")

    client = _get_client()
    for attempt in range(attempts):
        key = _current_key()
        headers = dict(fwd_headers)
        if key:
            headers["Authorization"] = "Bearer " + key
        _log(f"  attempt {attempt}: key#{_idx} ...{key[-6:]} -> sending")
        if _cfg.get("stream_mode"):
            # stream mode: status arrives before body bytes; rotate on
            # throttle codes without ever reading/leaking the body
            try:
                req = client.build_request(request.method, url,
                                           headers=headers, content=raw)
                upstream = await client.send(req, stream=True)
            except Exception as exc:
                last_resp = None
                _log(f"  attempt {attempt}: network error {exc}; rotating")
                _rotate()
                if attempt == attempts - 1:
                    return JSONResponse({"error": f"upstream failed: {exc}"},
                                        status_code=502)
                await asyncio.sleep(0.25 * (attempt + 1))
                continue
            _log(f"  attempt {attempt}: upstream HTTP {upstream.status_code}")
            should_rotate = upstream.status_code in ROTATE_CODES
            body400 = None
            if not should_rotate and upstream.status_code == 400:
                # sniff the 400 body for auth hints; the read CONSUMES the
                # stream, so a non-rotating 400 must be returned buffered
                body400 = await upstream.aread()
                low = (upstream.text or "").lower()
                should_rotate = any(h in low for h in ROTATE_HINTS)
            if should_rotate and len(_keys) > 1:
                await upstream.aclose()
                last_resp = None
                _rotate()
                await asyncio.sleep(0.25 * (attempt + 1))
                continue
            resp_headers = {k: v for k, v in upstream.headers.items()
                            if k.lower() not in {"content-length",
                                                 "transfer-encoding",
                                                 "connection"}}
            ct = upstream.headers.get("content-type", "")
            if _cfg.get("sig_repair") and "text/event-stream" not in ct \
                    and upstream.status_code == 200:
                # non-SSE response inside stream mode (stream:false requests):
                # buffer, harvest thought signatures, return plain body
                try:
                    body200 = await upstream.aread()
                    try:
                        _extract_sigs(json.loads(body200))
                    except Exception:
                        pass
                    plain = {k: v for k, v in resp_headers.items()
                             if k.lower() not in {"content-encoding",
                                                  "content-length"}}
                    return Response(content=body200,
                                    status_code=upstream.status_code,
                                    headers=plain,
                                    media_type=ct or "application/json")
                except Exception:
                    pass
            if _cfg.get("sig_repair") and "text/event-stream" in ct \
                    and upstream.status_code == 200:

                async def _tee(gen):
                    buf = b""
                    async for chunk in gen:
                        yield chunk
                        try:
                            buf += chunk
                            while b"\n" in buf:
                                line, buf = buf.split(b"\n", 1)
                                line = line.strip()
                                if line.startswith(b"data:"):
                                    payload = line[5:].strip()
                                    if payload and payload != b"[DONE]":
                                        try:
                                            _extract_sigs(json.loads(payload))
                                        except Exception:
                                            pass
                            if len(buf) > 16384:
                                buf = buf[-8192:]
                        except Exception:
                            pass

                return StreamingResponse(_tee(upstream.aiter_raw()),
                                         status_code=upstream.status_code,
                                         headers=resp_headers,
                                         media_type=ct or "application/json")
            if body400 is not None:
                # 400 without an auth hint: return the sniffed body intact.
                # aread() already decoded the transfer (gzip) so the
                # content-encoding header must be stripped or the caller
                # tries to gunzip plain JSON.
                plain_headers = {k: v for k, v in resp_headers.items()
                                 if k.lower() not in {"content-encoding",
                                                      "content-length"}}
                return Response(content=body400,
                                status_code=upstream.status_code,
                                headers=plain_headers,
                                media_type=ct or "application/json")
            return StreamingResponse(upstream.aiter_raw(),
                                     status_code=upstream.status_code,
                                     headers=resp_headers,
                                     media_type=ct or "application/json")
        try:
            upstream = await client.request(request.method, url,
                                            headers=headers, content=raw)
        except Exception as exc:
            last_resp = None
            _log(f"  attempt {attempt}: network error {exc}; rotating")
            _rotate()
            if attempt == attempts - 1:
                return JSONResponse({"error": f"upstream failed: {exc}"},
                                    status_code=502)
            await asyncio.sleep(0.25 * (attempt + 1))
            continue

        _log(f"  attempt {attempt}: upstream HTTP {upstream.status_code}")
        should_rotate = upstream.status_code in ROTATE_CODES
        if not should_rotate and upstream.status_code == 400:
            low = (upstream.text or "").lower()
            should_rotate = any(h in low for h in ROTATE_HINTS)
        if should_rotate and len(_keys) > 1:
            last_resp = upstream
            _rotate()
            await asyncio.sleep(0.25 * (attempt + 1))
            continue

        if _cfg.get("sig_repair"):
            try:
                _extract_sigs(json.loads(upstream.content))
            except Exception:
                pass
        resp_headers = {k: v for k, v in upstream.headers.items()
                        if k.lower() not in _DROP_RESP}
        ct = upstream.headers.get("content-type", "")
        if "text/event-stream" in ct:
            return StreamingResponse(upstream.aiter_bytes(),
                                     status_code=upstream.status_code,
                                     headers=resp_headers, media_type=ct)
        return Response(content=upstream.content,
                        status_code=upstream.status_code,
                        headers=resp_headers,
                        media_type=ct or "application/json")

    if last_resp is not None:
        resp_headers = {k: v for k, v in last_resp.headers.items()
                        if k.lower() not in _DROP_RESP}
        return Response(content=last_resp.content,
                        status_code=last_resp.status_code,
                        headers=resp_headers, media_type="application/json")
    return JSONResponse({"error": "all keys exhausted"}, status_code=429)


app = Starlette(routes=[
    Route("/health", _proxy, methods=["GET"]),
    Route("/{path:path}", _proxy, methods=["POST", "GET"]),
])

if __name__ == "__main__":
    print(f"[{_service}-proxy] {len(_keys)} key(s), upstream={UPSTREAM}, "
          f"port {PORT}, debug={DEBUG}", flush=True)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")
