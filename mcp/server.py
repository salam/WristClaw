"""WristClaw MCP server — read-only Streamable HTTP endpoint at /mcp.

Exposes protocol docs and a relay-health tool for AI agents that want to
understand what WristClaw is and whether the relay is currently up. No
write operations, no session data, no decryption — by design.
"""

from __future__ import annotations

import os

import httpx
from mcp.server.fastmcp import FastMCP

RELAY_HEALTH_URL = os.environ.get("RELAY_HEALTH_URL", "http://wristclaw-relay:8080/health")

mcp = FastMCP(
    name="WristClaw",
    instructions=(
        "WristClaw is a standalone Apple Watch app that talks to an OpenClaw AI "
        "agent over a zero-trust encrypted relay. This MCP server exposes read-only "
        "documentation as resources, plus a tool to check relay health."
    ),
    host=os.environ.get("MCP_HOST", "0.0.0.0"),
    port=int(os.environ.get("MCP_PORT", "8000")),
)


# ---------------------------------------------------------------------------
# Resources
# ---------------------------------------------------------------------------

@mcp.resource("wristclaw://about", mime_type="text/markdown")
def about() -> str:
    return (
        "# WristClaw\n\n"
        "Standalone Apple Watch + iPhone companion that connects to an OpenClaw "
        "AI agent through a stateless WebSocket relay. End-to-end encrypted with "
        "X25519 ECDH + ChaCha20-Poly1305 — the relay only sees ciphertext.\n\n"
        "- Site: https://wristclaw.app\n"
        "- Source: https://github.com/gado-ships-it/WristClaw\n"
        "- Relay endpoint: wss://wristclaw.app/ws\n"
        "- Health: https://wristclaw.app/health\n"
    )


@mcp.resource("wristclaw://protocol", mime_type="text/markdown")
def protocol() -> str:
    return (
        "# Relay protocol\n\n"
        "## JOIN frame (first message after WS connect, 17 bytes)\n\n"
        "| Bytes | Field      |\n"
        "|-------|------------|\n"
        "| 0:16  | session_id (UUID) |\n"
        "| 16    | role (0=OpenClaw host, 1=Watch guest) |\n\n"
        "## All subsequent frames (>= 37 bytes)\n\n"
        "| Bytes | Field      |\n"
        "|-------|------------|\n"
        "| 0:16  | session_id |\n"
        "| 16    | msg_type   |\n"
        "| 17:21 | seq (LE u32) |\n"
        "| 21:25 | payload_len (LE u32) |\n"
        "| 25:37 | nonce (12 bytes) |\n"
        "| 37:   | ciphertext (ChaCha20-Poly1305) |\n\n"
        "## Message types\n\n"
        "| Type | Hex | Direction | Payload |\n"
        "|------|-----|-----------|---------|\n"
        "| HANDSHAKE | 0x01 | both | X25519 pubkey (32) |\n"
        "| AUDIO_INPUT | 0x02 | Watch→Host | AAC chunk |\n"
        "| TEXT_INPUT | 0x03 | Watch→Host | UTF-8 |\n"
        "| AUDIO_RESPONSE | 0x04 | Host→Watch | AAC |\n"
        "| TEXT_RESPONSE | 0x05 | Host→Watch | UTF-8 |\n"
        "| IMAGE_THUMBNAIL | 0x06 | Host→Watch | JPEG ≤40KB |\n"
        "| ACK | 0x07 | both | seq (4) |\n"
        "| HEARTBEAT | 0x08 | both | empty |\n"
        "| DISCONNECT | 0x09 | both | empty |\n"
    )


@mcp.resource("wristclaw://security", mime_type="text/markdown")
def security() -> str:
    return (
        "# Security & privacy\n\n"
        "- **Zero-trust relay.** The relay router cannot decrypt or inspect any "
        "payload — it only sees `[session_id | type | seq | nonce | ciphertext]`.\n"
        "- **Key exchange** is X25519 ECDH during pairing.\n"
        "- **Symmetric cipher** is ChaCha20-Poly1305 (AEAD).\n"
        "- **KDF** is HKDF-SHA256 from the ECDH shared secret.\n"
        "- **Nonces** are fresh 12-byte random bytes per message.\n"
        "- **Session IDs** are random 128-bit UUIDs generated at pairing time.\n"
        "- **Private keys** never leave the device that generated them (Watch or Host).\n"
        "- **Audio** is encrypted before the first byte hits the network.\n"
        "- A compromised relay yields encrypted blobs and connection metadata only.\n"
    )


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

@mcp.tool()
async def relay_status() -> dict:
    """Return current relay health and reachability.

    Calls the relay's /health endpoint over the docker-compose network.
    Returns ``{"ok": bool, "status_code": int, "body": str}``.
    """
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(RELAY_HEALTH_URL)
        return {
            "ok": r.status_code == 200 and r.text.strip() == "ok",
            "status_code": r.status_code,
            "body": r.text.strip(),
        }
    except httpx.HTTPError as exc:
        return {"ok": False, "error": str(exc)}


@mcp.tool()
def protocol_summary() -> dict:
    """One-shot machine-readable summary of the relay protocol."""
    return {
        "endpoint": "wss://wristclaw.app/ws",
        "join_frame_bytes": 17,
        "header_bytes": 37,
        "max_payload_mb": 2,
        "encryption": {
            "kex": "X25519 ECDH",
            "cipher": "ChaCha20-Poly1305",
            "kdf": "HKDF-SHA256",
            "nonce_bytes": 12,
        },
        "message_types": {
            "0x01": "HANDSHAKE",
            "0x02": "AUDIO_INPUT",
            "0x03": "TEXT_INPUT",
            "0x04": "AUDIO_RESPONSE",
            "0x05": "TEXT_RESPONSE",
            "0x06": "IMAGE_THUMBNAIL",
            "0x07": "ACK",
            "0x08": "HEARTBEAT",
            "0x09": "DISCONNECT",
        },
    }


if __name__ == "__main__":
    # Streamable HTTP transport. The SDK exposes a Starlette ASGI app on /mcp;
    # uvicorn binds it. PORT is set by the Dockerfile / compose.
    mcp.run(transport="streamable-http")
