# Unitrends Backup MCP Server

[![CI](https://github.com/WYRE-AI/unitrends-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/WYRE-AI/unitrends-mcp/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

A [Model Context Protocol](https://modelcontextprotocol.io) server exposing the
[Unitrends Backup](https://www.unitrends.com/) API to Claude and other MCP clients.

## What it does

Surface backup posture from your Unitrends appliances (or MSP Console) directly
to AI assistants — list appliances and protected assets, monitor running and
historical backup jobs, browse recovery points, queue restores and replication,
and review open alarms and RPO compliance.

- **Interactive Appliance Card (MCP Apps)**: `unitrends_get_appliance` renders as an interactive card in MCP Apps hosts (Claude Desktop/web); neutral by default, brandable via `window.__BRAND__` injection or `MCP_BRAND_*` env vars; plain-JSON behavior is unchanged in other hosts

## Tools

| Tool | Purpose |
| --- | --- |
| `unitrends_list_appliances` | List appliances under the MSP Console |
| `unitrends_get_appliance` | Get a single appliance's details (renders as an interactive card in MCP Apps hosts) |
| `unitrends_list_assets` | List protected assets (require applianceId — elicits if missing) |
| `unitrends_get_asset` | Fetch a single asset detail |
| `unitrends_list_running_jobs` | Currently running and queued backup jobs |
| `unitrends_list_job_history` | Historical jobs (date-range elicitation) |
| `unitrends_list_recovery_points` | Recovery points for an asset |
| `unitrends_queue_restore` | Queue a restore (DESTRUCTIVE — requires confirmation) |
| `unitrends_get_restore_status` | Check restore progress |
| `unitrends_list_alerts` | Open alarms |
| `unitrends_get_success_rate` | RPO compliance report (date-range elicitation) |

## Credentials

Copy [`.env.example`](.env.example). Leave `CONDUIT_S2S_SECRET` empty in that file.

### Local (env mode and stdio)

The stdio transport reads these variables and does not use `CONDUIT_S2S_SECRET`.

```sh
export UNITRENDS_BASE_URL="https://unitrends.example.com"
export UNITRENDS_USERNAME="..."
export UNITRENDS_PASSWORD="..."
export UNITRENDS_VERIFY_TLS="true"   # 'false' for self-signed appliances
```

### HTTP service-to-service auth

`CONDUIT_S2S_SECRET` is required when `MCP_TRANSPORT=http`. If it is empty, or a known placeholder (`changeme`, `change-me`, `placeholder`, `secret`, `example`, `your-s2s-secret`, `your-secret`, `replace-me`, `replace-with-a-real-secret`, `s2s-secret`), the process logs an error and exits non-zero. It never prints the secret. Generate one with `openssl rand -hex 32`.

`MCP_ALLOW_INSECURE_DEV=1` is the only way to start HTTP without that secret. The flag must be exactly `1`. The process logs a warning, does not check `X-Gateway-S2S`, and listens on `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` (including `0.0.0.0`) is ignored in that mode and the override is logged. A known placeholder still refuses to start; unset the secret to use the bypass.

`MCP_HTTP_HOST` is honored when a real secret is set, including `0.0.0.0`. When `MCP_HTTP_HOST` is unset and a secret is set, the server binds `0.0.0.0`. When there is no secret, the bind address is `127.0.0.1`. The container image sets `MCP_HTTP_HOST=0.0.0.0`.

With a real secret, every `/mcp` request must include `X-Gateway-S2S`. The value is `t=<unix seconds>,v1=<hex hmac-sha256>`. The MAC is HMAC-SHA256 over the ASCII string `t=<unix seconds>` (the same prefix that appears in the header), keyed with `CONDUIT_S2S_SECRET`. The timestamp must be within 300 seconds of the server clock. A missing or invalid header is `401` and is rejected before any vendor credential is read.

`/health` stays unauthenticated, does not read credentials, and is the container health check.

### Hosted (gateway mode)

`AUTH_MODE=gateway` (the Compose default) requires these headers on every `/mcp` request. A request missing any of the required headers is `401` and does not fall back to `UNITRENDS_*` in the process environment.

- `X-Unitrends-Base-URL` (required)
- `X-Unitrends-Username` (required)
- `X-Unitrends-Password` (required, secret)
- `X-Unitrends-Verify-TLS` (optional, default `true`)
- `X-Gateway-S2S` (required when `CONDUIT_S2S_SECRET` is set)

```typescript
// Gateway injects vendor credentials and the X-Gateway-S2S proof
const response = await fetch("http://gateway:8080/mcp", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-gateway-s2s": "<t=unix,v1=hmac-sha256 of t=unix, keyed with CONDUIT_S2S_SECRET>",
    "x-unitrends-base-url": "https://unitrends.example.com",
    "x-unitrends-username": "your_username",
    "x-unitrends-password": "your_password",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
```

Single-tenant HTTP (`AUTH_MODE=env`, the image default) still requires a valid `X-Gateway-S2S` header, then reads `UNITRENDS_*` from the environment when the request does not carry credential headers.

## Run

```sh
npm install
npm run build
npm start                       # stdio

# HTTP refuses to start until CONDUIT_S2S_SECRET is a real secret
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" MCP_TRANSPORT=http npm start

# Local HTTP only, without a service-to-service secret (always binds 127.0.0.1)
MCP_TRANSPORT=http MCP_ALLOW_INSECURE_DEV=1 npm start
```

### Docker

The image listens on `0.0.0.0` inside the container and defaults to `AUTH_MODE=env`. Publish the port on loopback and pass the S2S secret. HTTP will not start when `CONDUIT_S2S_SECRET` is empty or a known placeholder.

```sh
docker build -t unitrends-mcp .
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e UNITRENDS_BASE_URL="https://unitrends.example.com" \
  -e UNITRENDS_USERNAME="..." \
  -e UNITRENDS_PASSWORD="..." \
  -p 127.0.0.1:8080:8080 \
  unitrends-mcp
```

Gateway mode does not read those vendor variables. Credentials arrive on each request, and the request must also carry `X-Gateway-S2S` signed with `CONDUIT_S2S_SECRET`:

```sh
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e AUTH_MODE=gateway \
  -p 127.0.0.1:8080:8080 \
  unitrends-mcp
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset or empty, sets `AUTH_MODE=gateway`, does not inject `UNITRENDS_BASE_URL`, `UNITRENDS_USERNAME`, or `UNITRENDS_PASSWORD`, and publishes `127.0.0.1:8080:8080`:

```sh
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" docker compose up
```

## License

Apache 2.0 — see [LICENSE](LICENSE).
