# CodexLink Relay Protocol Spec

Status: experimental loopback prototype.

This spec supports the v1.2 zero-setup roadmap. It includes a local-only relay prototype for safety testing; it is not a hosted production relay server.

## Transport

```text
GPTs Actions
  -> HTTPS relay endpoint
  -> paired device/session router
  -> outbound WSS connection from local launcher
  -> local AgentBridge HTTP bridge
```

## Pairing

- Pairing is required.
- Pairing code TTL: 300 seconds.
- Pairing code is single-use.
- Requests are bound to a GPT session and connected device.
- Revocation is required before relay can be considered production-ready.

## MVP Limits

- Max request size: 64 KB.
- Max response size: 512 KB.
- Max requests per minute per device: 60.
- Max requests per minute per session: 30.

## Allowed Route Categories

Relay MVP may only expose bounded metadata routes:

- project picker metadata
- session summary
- compact session context
- session timeline
- relay pairing metadata
- relay health metadata

It must not expose arbitrary local paths, arbitrary HTTP forwarding, command execution, file writes, raw diffs, or raw file content storage.

Machine-readable source:

```text
src/relayProtocol.ts
```

CLI inspection:

```powershell
node dist\cli.js relay spec
node dist\cli.js relay spec --json
```

Local pairing preparation:

```powershell
node dist\cli.js relay pairing create
node dist\cli.js relay pairing status
node dist\cli.js relay pairing bind --code <CODE> --gpt-session <safe-session-hint>
node dist\cli.js relay pairing revoke
```

These commands do not start a relay server. The raw pairing code is printed once by `create`; `.agentbridge/relay-pairing.json` stores a hash, expiry, device ID, and status metadata only.

## Request Envelope Validation

Before any future relay server forwards a request to a local launcher, it must validate a bounded request envelope:

```json
{
  "operation_id": "getSessionSummary",
  "method": "GET",
  "path": "/chatgpt/projects/AgentBridge/session/summary",
  "project_id": "AgentBridge"
}
```

The validator in `src/relayProtocol.ts` rejects:

- operations not present in the allowlist
- method/path mismatches
- `/mcp`
- filesystem-looking project IDs or paths
- traversal such as `..`
- request bodies larger than the MVP byte cap
- forbidden capability terms such as file write, command runner, local token, or OpenAI API key

This is still not a production relay. It is a guardrail for the next implementation phase.

## Local Dispatch Dry-Run

The local dispatcher in `src/relayLocalDispatch.ts` can execute allowlisted metadata operations without opening a relay server:

```powershell
node dist\cli.js relay dispatch listProjects --json
node dist\cli.js relay dispatch getSessionSummary --project AgentBridge --json
node dist\cli.js relay dispatch getSessionContext --project AgentBridge --json
node dist\cli.js relay dispatch getSessionTimeline --project AgentBridge --mode recent --json
```

This is local-only and validates the envelope before dispatch. It does not expose a network listener, does not use `.agentbridge/local_token`, and does not add write-file, shell, scan, or HTTP MCP capability.

## Experimental Loopback Relay Prototype

For local protocol testing only:

```powershell
node dist\cli.js relay serve --experimental --host 127.0.0.1 --port 8787
```

The prototype:

- binds only to loopback hosts
- serves public `GET /relay/health`
- accepts `POST /relay/pair` with a short-lived pairing code
- requires `X-CodexLink-Relay-Session` for allowlisted `/chatgpt/*` metadata dispatch
- does not read or print `.agentbridge/local_token`
- does not expose `/mcp`
- does not expose shell, write-file, scan, raw file content, raw diff, or long terminal output

This is not the stable hosted relay endpoint needed for final zero-setup GPT Actions. That still requires a hardened HTTPS/WSS relay service and end-to-end security review.

Loopback acceptance smoke:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\smoke-v12-relay-loopback.ps1
```

The smoke test bootstraps a local session, creates a short-lived pairing code, starts the loopback relay prototype, pairs a fake GPT session, calls project/session metadata routes through the relay, checks `/mcp` stays unavailable, and verifies secret-like text is not returned.

## GPT Actions Relay Schema

Prototype schema:

```text
openapi.codexlink.relay.gpt-actions.json
```

This schema uses the placeholder server:

```text
https://relay.codexlink.example.com
```

It only contains relay health, pairing, project picker, session summary, compact context, and timeline metadata routes. Use the direct `openapi.agentbridge.gpt-actions.json` schema for stable tunnel/domain mode today.

## Forbidden Capabilities

- No arbitrary shell or command runner.
- No file write or edit route.
- No local auth token exposure to GPTs.
- No OpenAI API key requirement.
- No HTTP MCP endpoint.
- No raw file content relay storage.
- No raw diff relay storage.
- No long terminal output relay storage.

## Audit Policy

Relay logs must be metadata-only and redacted. The relay must never become the source of truth for workspace memory; local AgentBridge remains authoritative.
