# syntax=docker/dockerfile:1
# Web-Stack MCP — single container running every web/browser upstream MCP,
# the tavily/firecrawl/context7 key-rotation relay, and the aggregator.
FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    CHROME_PATH=/usr/local/bin/chromium

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl git ca-certificates wget unzip build-essential pkg-config libssl-dev \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Node-based MCP servers (pinned)
RUN npm install -g \
      @playwright/mcp@0.0.86 \
      chrome-devtools-mcp@1.13.0 \
      firecrawl-mcp@3.41.0 \
      tavily-mcp@0.2.22 \
      @upstash/context7-mcp@4.7.3 \
      fatsearch@0.2.5
RUN npx playwright install --with-deps chromium || npx playwright install chromium
RUN ln -sf "$(ls -d /root/.cache/ms-playwright/chromium-*/chrome-linux*/chrome | head -1)" /usr/local/bin/chromium

# Key-rotation relay + process supervisor
RUN pip install --no-cache-dir httpx "uvicorn[standard]" starlette supervisor

# Stealth browser MCP (nodriver) in its own venv
RUN git clone --depth 1 --branch v0.3.4 https://github.com/vibheksoni/stealth-browser-mcp.git /opt/stealth-browser-mcp \
 && python -m venv /opt/stealth-venv \
 && /opt/stealth-venv/bin/pip install --no-cache-dir -r /opt/stealth-browser-mcp/requirements.txt

# Scrapling (TLS/JA3 + HTTP/3 fingerprint impersonation) in its own venv
RUN python -m venv /opt/scrapling-venv \
 && /opt/scrapling-venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/scrapling-venv/bin/pip install --no-cache-dir "scrapling[ai]"

COPY app/ /app/
COPY key-proxy/key_rotate_proxy.py /opt/key-proxy/key_rotate_proxy.py
COPY wait_web_stack.py /opt/wait_web_stack.py
COPY supervisord.conf /etc/supervisor/supervisord.conf
COPY config/web-stack.config.example.json /data/web-stack/config.json

EXPOSE 4032
CMD ["supervisord", "-c", "/etc/supervisor/supervisord.conf"]
