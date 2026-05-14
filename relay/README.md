# WristClaw Relay Server

Stateless WSS relay for WristClaw Apple Watch app. Handles encrypted message forwarding between watch and OpenClaw agent.

## Architecture

- **Zero-trust**: Relay sees only ciphertext (X25519 + ChaCha20-Poly1305)
- **Stateless**: Messages kept in ephemeral store until watch reconnects
- **Single binary**: Deploy with Docker or Go binary

## Key Features

### Message Persistence

The relay **keeps all messages** (text, audio, images, binary) in an in-memory store until the watch app (re-)connects. This ensures:

1. Watch can reconnect at any time and get all missed messages
2. Session recovery after watch reboots or network interruptions
3. No message loss during temporary connectivity gaps

### Encryption Flow

1. Watch sends pairing payload → relay derives shared key
2. All subsequent messages encrypted with ephemeral session key
3. Relay forwards ciphertext end-to-end
4. Keys never leave devices

## Deployment

### Docker

```bash
docker run -d \
  -p 8443:8443 \
  -e OPENCLAW_HOST=http://your-agent:8080 \
  wristclaw-relay:latest
```

### Manual

```bash
go build -o relay main.go
./relay --listen=:8443
```

## Message Flow

```
Watch → [Encrypted] → Relay → [Encrypted] → OpenClaw Agent
```

Relay cannot read or modify messages.

## Session Management

- Each pairing session has unique ID + key pair
- Sessions remain active until timeout (configurable)
- Watch auto-reconnects on disconnect with same session ID
- Old sessions garbage collected on startup

## Security

- TLS 1.3 only
- Perfect forward secrecy
- No logging of message content
- Minimal metadata (connection timestamps only)
