import socket, time, os
# Wait for every internal upstream, then start the aggregator bridge.
ports = [4002, 4003, 4007, 4008, 4009, 4023, 4027, 4033]
for p in ports:
    for _ in range(120):
        try:
            socket.create_connection(('127.0.0.1', p), 2).close(); break
        except Exception:
            time.sleep(2)
os.execvp('node', ['node', '/app/mcp_http_bridge.js', '4032', 'node', '/app/web_stack_mcp.js'])
