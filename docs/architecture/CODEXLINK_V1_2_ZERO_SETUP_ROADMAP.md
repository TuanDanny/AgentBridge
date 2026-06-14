# CodexLink v1.2 Zero-Setup Launcher Roadmap

This roadmap is historical context for the v1.2 relay work. The current codebase includes a hosted relay MVP for paired metadata/inspector routes; it is still not a hosted account/team/cloud workspace service and does not add write, shell, or HTTP MCP capability.

The v1.2 goal is to move closer to a real beginner-friendly flow:

```text
download repo -> run .bat -> open GPTs -> use CodexLink
```

without requiring the user to deeply understand tunnels, public URLs, GPT Actions schema updates, or relay security. This roadmap is intentionally conservative: v1.2 should reduce setup friction without weakening the v1.0/v1.1 safety model.

## A. Problem Statement

GPT Actions need a fixed HTTPS endpoint.

That creates friction:

- Cloudflare Quick Tunnel URLs change after restart.
- Stable tunnels or domains solve the URL problem, but still require one-time setup.
- The v1.1 one-click launcher is truly one-click only after a stable endpoint or relay is available.
- If a user uses a quick tunnel, they may need to update the GPT Actions server URL repeatedly.
- If a user uses a stable tunnel, they still need to understand Cloudflare/domain setup at least once.

The v1.2 goal is to reduce setup as much as possible while keeping workspace access safe. CodexLink should not overpromise “zero setup” until relay mode or an equivalent stable endpoint path is implemented and security-tested.

## B. Current v1.1 UX

Current first-time setup:

```text
npm install/build
setup launcher
setup stable public URL or quick tunnel
paste GPT Actions schema
configure bearer auth in GPT Builder
```

Current daily usage:

```text
double-click start-codexlink.bat
GPT greeting copied/opened
use GPTs
```

What v1.1 already improves:

- Starts or reuses the local AgentBridge server.
- Verifies local `/health`.
- Bootstraps shared session/context.
- Copies a GPT greeting prompt.
- Opens the configured GPT URL if present.
- Warns when no stable public URL is configured.

Remaining inconvenience:

- Quick tunnels still require GPT Actions URL updates when the URL changes.
- Stable tunnels require a domain or provider setup.
- Beginners may not know whether the issue is local server, public URL, GPT Actions schema, auth, or tunnel.

## C. Candidate Solutions

### 1. Cloudflare Named Tunnel + FreeDomain/Domain

Summary: use a stable Cloudflare tunnel hostname, optionally with a free or owned domain.

Strengths:

- Most practical near-term path.
- Stable URL for GPT Actions.
- No CodexLink-hosted relay required.
- Good security controls if configured carefully.
- Compatible with v1.1 launcher.

Tradeoffs:

- User still performs one-time setup.
- DNS/tunnel concepts can confuse beginners.
- Requires documentation and doctor checks to catch URL mismatch.

Fit for v1.2:

- Best practical path for alpha.
- Should be documented as the recommended production option before hosted relay exists.

### 2. Ngrok Static Domain

Summary: use an ngrok static domain as the GPT Actions server URL.

Strengths:

- Easier than Cloudflare for some users.
- Good developer UX.
- Stable URL can work well with GPT Actions.

Tradeoffs:

- Account/plan limits may apply.
- Still requires provider setup.
- External dependency and rate/plan constraints are outside CodexLink control.

Fit for v1.2:

- Good alternate guide.
- Useful for demos and early users.

### 3. Hosted CodexLink Relay

Summary: CodexLink operates a stable relay endpoint. The local launcher connects outward over WSS. GPT Actions call the relay, which routes safe requests to the paired local device.

Strengths:

- Best UX.
- No user-owned domain.
- No public inbound local port.
- One stable GPT Actions URL.

Tradeoffs:

- Requires production server operations.
- Requires authentication, device pairing, rate limits, encryption, abuse protection, and security audit.
- Creates a high-value boundary between GPTs and local workspaces.

Fit for v1.2:

- Should be specified and prototyped cautiously.
- Hosted production should not ship until security acceptance is strong.

### 4. Self-Host Relay

Summary: provide a relay server that technical users can run themselves.

Strengths:

- Safer than a public hosted relay for early testing.
- Lets advanced users validate the protocol.
- Reduces central service trust.

Tradeoffs:

- Not beginner-friendly.
- Still requires server hosting.
- Does not fully solve zero setup for non-technical users.

Fit for v1.2:

- Good gamma prototype target before hosted relay.

### 5. Desktop App / Tauri / Electron Launcher

Summary: package CodexLink into a desktop app that manages local server state and user-facing setup.

Strengths:

- Better UX than scripts.
- Can guide install, health, pairing, and docs.
- Could make logs/doctor clearer.

Tradeoffs:

- Does not remove the need for a fixed HTTPS endpoint if GPT Actions calls back to the local machine.
- Adds packaging, signing, update, and trust work.

Fit for v1.2:

- Helpful UX layer later.
- Not a replacement for stable tunnel or relay.

## D. Recommended Path

### v1.2-alpha: Practical Stable Endpoint Wizard

Deliverables:

- Stable endpoint wizard improvements.
- Clear guide for FreeDomain + Cloudflare Named Tunnel.
- Optional ngrok static domain guide.
- Doctor detects URL mismatch and suggests a fix.
- `setup gpt-actions --public-url` generates a stable schema.
- Launcher opens GPTs and copies the greeting.
- Warnings stay explicit for quick tunnel URLs.

Goal:

- Make the best current path understandable and repeatable.

Non-goals:

- No hosted relay.
- No arbitrary shell/write capability.
- No production relay code.

### v1.2-beta: Local Pairing And Install Bundle

Deliverables:

- Local pairing config placeholder.
- Per-device local identity placeholder.
- Generate a per-device install bundle.
- One-click installer script for Windows.
- Optional Windows service for the local server.
- Optional cloudflared service detection.

Goal:

- Reduce repeat setup and make local readiness durable across restarts.

Non-goals:

- No hosted relay production.
- No GPTs ability to write files.

### v1.2-gamma: Relay Protocol And Self-Host Prototype

Deliverables:

- Relay protocol spec.
- Message schema.
- Self-host relay prototype.
- Outbound WebSocket client prototype.
- Pairing code lifecycle.
- Relay health checks.

Goal:

- Prove the relay boundary safely before any hosted service.

Non-goals:

- No public hosted relay launch.
- No shell runner.
- No file write/edit through relay.

### v1.2-delta: Relay Experiment And Security Review

Deliverables:

- End-to-end relay experiment.
- Strict safety review.
- Rate limit tests.
- Audit metadata tests.
- Redaction tests.
- Request size cap tests.
- Replay/expired pairing tests.

Goal:

- Decide whether hosted relay is safe enough to proceed.

Non-goals:

- No production hosted relay until acceptance is explicit.
- No weakening of v1.0/v1.1 local safety.

## E. Hosted Relay Architecture Proposal

Target architecture:

```text
GPTs Actions
  -> stable relay HTTPS endpoint
  -> device/session router
  -> outbound WSS connection from local launcher
  -> local AgentBridge server
  -> registered project workspace
```

Key design points:

- GPT Actions uses one stable relay URL.
- Local launcher opens an outbound WSS connection.
- No public inbound port is required on the user machine.
- Relay maps paired GPT sessions to a live device connection.
- Local AgentBridge remains the source of truth and enforces project safety.
- Relay forwards bounded request/response envelopes only.

## F. Pairing Model

Proposed pairing flow:

1. Launcher creates or loads a local device ID.
2. Launcher connects to relay over WSS.
3. Relay creates a short-lived pairing code.
4. User pastes the code into GPTs, or GPTs calls a `pairDevice` action.
5. Relay binds the GPT session to the device connection.
6. GPT Actions requests are allowed only for that paired device/session.
7. User can revoke the device/session binding.

Requirements:

- Pairing code expires quickly.
- Pairing code is single-use or tightly replay-protected.
- Device token stays local.
- Connected devices are visible to the user.
- Revocation is available from local CLI and future UI.

## G. Security Requirements

Mandatory requirements:

- Relay does not store raw file content.
- Relay does not store raw diffs.
- Relay does not store long raw terminal output.
- Relay logs are redacted.
- No `.agentbridge/local_token` is exposed to GPTs.
- No raw local bearer token is exposed to GPTs.
- Pairing code is short-lived.
- Per-device token is stored locally and not printed.
- Project allowlist remains local.
- Local AgentBridge still enforces safe file policy.
- No arbitrary command runner.
- No file write/edit capability in relay phase.
- Rate limits on device, session, IP, and route.
- Request size caps.
- Response size caps.
- Audit activity metadata only.
- User-visible connected device list.
- Revocation command.
- Optional self-host relay mode.
- No OpenAI API key requirement.
- No HTTP `/mcp` endpoint.

Security posture:

- Relay is a transport boundary, not an authority to bypass local policy.
- Local agent must be able to reject any unsafe request even if relay forwards it.
- Hosted relay must pass no-secret/no-raw-content tests before production use.

## H. Acceptance Criteria

The roadmap is successful when:

- New users understand two paths:
  - practical stable tunnel now
  - future relay later
- Documentation does not overpromise zero setup before relay exists.
- v1.1 launcher remains stable without relay.
- v1.0/v1.1 safety model is not weakened.
- No GPTs path can run arbitrary shell commands.
- No GPTs path can write/edit files through relay.
- No token is printed.
- No OpenAI API key is required.
- Docs are sufficient to decide the v1.2 implementation sequence.

## I. README Summary

README should say:

- v1.2 zero-setup roadmap is planned.
- Current v1.1 one-click still needs a stable endpoint for no URL changes.
- Quick tunnels are good for testing but not stable daily use.
- See this roadmap for relay design and safety requirements.

## J. Relationship To Existing Relay Plan

This roadmap complements:

```text
docs/architecture/CODEXLINK_ZERO_SETUP_RELAY_PLAN.md
```

That document focuses on relay architecture. This document focuses on the practical v1.2 product roadmap from v1.1 launcher toward safer zero-setup UX.

## K. Implementation Guardrails

Do not implement production relay until:

- relay protocol is specified
- pairing is specified and tested
- revocation is specified and tested
- redaction and log policy are tested
- request/response caps are tested
- route allowlist is explicit
- no arbitrary command runner exists
- no file write/edit exists
- no token is printed

The first implementation step should be docs, wizard/doctor improvements, and self-host relay prototype planning, not hosted production relay.
