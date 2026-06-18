# CodexLink Hosted Relay MVP

Hosted relay mode is the v1.2 zero-setup path for GPT Actions. It lets GPTs use one stable HTTPS URL while the user's machine opens an outbound WebSocket to the relay. The relay is read-only for workspace data and forwards only allowlisted metadata/inspector requests.

## What This Solves

- Quick tunnel URLs change.
- Stable Cloudflare tunnels require a domain and one-time setup.
- GPT Actions need a fixed HTTPS server URL.
- Daily use should be: double-click `start-codexlink.bat`, pair GPTs, then use project/session/inspector actions.

## Architecture

```text
GPT Actions
  -> https://relay.codexlink.example.com
  -> pairing/session-bound hosted relay
  -> outbound WSS from start-codexlink launcher
  -> local AgentBridge dispatcher
```

The relay does not store workspace content. Local AgentBridge remains the source of truth and revalidates every request.

## Deploy Hosted Relay

Build first:

```powershell
npm install
npm run build
```

Run the relay behind your hosting platform's HTTPS/WSS proxy:

```powershell
node dist\cli.js relay hosted serve --host 0.0.0.0 --port 8788 --public-url https://relay.codexlink.example.com
```

For local loopback testing:

```powershell
node dist\cli.js relay hosted serve --host 127.0.0.1 --port 8788 --public-url https://relay.codexlink.example.com
```

The app serves HTTP internally. HTTPS/WSS termination is expected from the platform, reverse proxy, or tunnel in front of it.

### Docker Compose

Docker runs only the hosted relay service. Local AgentBridge, project files, and `.agentbridge` state remain on the user's machine and connect outbound over WSS.

```powershell
$env:CODEXLINK_PUBLIC_URL="https://relay.example.com"
docker compose up --build -d
docker compose ps
Invoke-RestMethod http://127.0.0.1:8788/relay/health
```

Stop it with:

```powershell
docker compose down
```

`CODEXLINK_PUBLIC_URL` must be the stable external HTTPS origin configured in GPT Actions. Port `8788` serves plain HTTP inside the container; terminate HTTPS/WSS at the hosting platform or reverse proxy. The Compose service uses a read-only filesystem, drops Linux capabilities, runs as the non-root `node` user, and mounts no workspace directories.

## Configure User Machine

First-time setup on a new machine:

```powershell
setup-codexlink-first-time.bat
node dist\cli.js setup launcher --project AgentBridge --tunnel-mode relay --relay-url https://relay.codexlink.example.com --gpt-url https://chatgpt.com/g/YOUR-GPT
```

Daily use:

```powershell
start-codexlink.bat
```

The launcher starts local AgentBridge, creates a short-lived pairing code, starts the outbound relay client, copies a GPT greeting, and optionally opens the configured GPT URL.

Stop local processes:

```powershell
stop-codexlink.bat
```

## GPT Builder

Import:

```text
openapi.codexlink.relay.gpt-actions.json
```

Replace the schema server URL with your trusted relay origin. GPTs first calls `pairDevice` with the short-lived code. The response returns `relay_session`; subsequent calls use the `X-CodexLink-Relay-Session` header.

Allowed relay operations:

- `relayHealth`
- `pairDevice`
- `listProjects`
- `getSessionSummary`
- `getSessionContext`
- `getSessionTimeline`
- `inspectProject`
- `getCodexChanges`
- `getReviewPacket`
- `getProjectTree`
- `searchProjectFiles`
- `readProjectFile`
- `searchProjectText`

No `/mcp` endpoint is exposed.

## Security Model

- No OpenAI API key is required.
- No account/team/cloud workspace mode is added.
- Pairing codes are short-lived and single-use.
- Raw pairing code is printed/copied once and is not stored.
- `.agentbridge/relay-device.json` is local runtime state and must not be committed.
- Relay sessions are in-memory for the MVP; relay restart requires re-pairing.
- Relay forwards only allowlisted read-only metadata/inspector routes.
- Local client revalidates operation, method, path, and project id before dispatch.
- `readProjectFile` uses existing local safe path, binary, secret, and truncation policy.
- Relay must not store raw file content, raw diffs, long terminal output, bearer tokens, `.env`, or private keys.

## Troubleshooting

- `401 relay_session_required`: run `start-codexlink.bat`, copy the new pairing code, call `pairDevice`, and use the returned relay session header.
- `503 relay_device_unavailable`: the local relay client is not connected or was stopped.
- `404 Project not found`: register/select the local project or use the project id from `listProjects`.
- GPT Actions schema import issue: run `npm run generate:openapi` and re-import `openapi.codexlink.relay.gpt-actions.json`.
- Hosted `/relay/health` fails: check deployment URL, HTTPS/WSS proxy, and port mapping.

## Acceptance

Run:

```powershell
npm run generate:openapi
npm run build
npm test
git diff --check
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\smoke-v12-hosted-relay-e2e.ps1
```
