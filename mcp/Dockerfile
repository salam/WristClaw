FROM python:3.12-slim

RUN useradd --system --create-home --shell /usr/sbin/nologin mcp
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .

USER mcp
EXPOSE 8000

# FastMCP defaults to 127.0.0.1:8000; server.py reads MCP_HOST / MCP_PORT
# and passes them to the FastMCP constructor. Bind 0.0.0.0 so docker-proxy
# can reach us; the host-side bind (loopback in prod) is set in compose.
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=8000

CMD ["python", "server.py"]
