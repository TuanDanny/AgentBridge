# CodexLink v1.2 Zero-Setup Stable Relay Plan

This is a design backlog for v1.2. It does not implement a production relay server.

The goal is the real daily workflow:

```text
double-click start-codexlink.bat -> open GPTs -> use CodexLink immediately
```

without requiring the user to manually maintain Cloudflare quick tunnel URLs, own a domain, or update GPT Actions whenever the public endpoint changes.

## A. Problem

CodexLink v1.1 improves local startup when the user already has a stable public HTTPS URL. The remaining gap is the public endpoint.

Current options have friction:

- Cloudflare quick tunnels create temporary URLs.
- A stable Cloudflare named tunnel needs a domain and one-time DNS/tunnel setup.
- GPT Actions require a fixed HTTPS server URL in the imported OpenAPI schema.
- Users want to run a `.bat`, open GPTs, and start working without tunnel/domain maintenance.

Therefore CodexLink needs either:

- a stable tunnel configured once, or
- a stable relay endpoint that GPT Actions can call every time.

The relay option is powerful but high-risk because it can reach a local workspace. It must be designed as a security boundary, not a convenience proxy.

## B. Candidate Solutions

### 1. Cloudflare Named Tunnel + Domain

Summary: user owns or controls a domain and creates a named tunnel that maps a stable hostname to local AgentBridge.

Strengths:

- Stable HTTPS endpoint.
- Strong Cloudflare security features.
- Self-host/local-first friendly.
- No CodexLink-hosted relay required.

Tradeoffs:

- Requires domain/DNS setup.
- More steps than true one-click.
- Harder for non-technical users.

Best fit:

- Power users.
- Teams that already own a domain.
- Users who prefer self-managed infrastructure.

### 2. Ngrok Static Domain

Summary: user uses an ngrok account and static domain to expose local AgentBridge.

Strengths:

- Usually easier than Cloudflare DNS setup.
- Stable URL can work well for GPT Actions.
- Good developer UX.

Tradeoffs:

- Account/plan limits may apply.
- Still requires external setup.
- Trust and billing depend on ngrok.

Best fit:

- Individual users who want a quicker stable tunnel setup.
- Demo/testing environments.

### 3. CodexLink Hosted Relay

Summary: CodexLink provides a stable relay URL. The local launcher opens an outbound WebSocket to the relay. GPT Actions call the relay, and the relay forwards allowed requests to the local agent through the outbound connection.

Strengths:

- Best user experience.
- No public inbound port.
- No user-owned domain required.
- GPT Actions can keep one stable server URL.

Tradeoffs:

- Requires a secure server service.
- Needs pairing, device identity, rate limits, revocation, monitoring, and abuse controls.
- Adds operational cost and trust boundary.

Best fit:

- True consumer-friendly “double-click and use GPTs” workflow.
- Optional hosted mode for users who do not want domain/tunnel setup.

### 4. Local-Only Browser Extension

Summary: a browser extension bridges ChatGPT/GPTs browser context to localhost.

Strengths:

- Could avoid public exposure for some browser workflows.
- Local-first by design.
- Might provide a nice UX for users in one browser.

Tradeoffs:

- Browser extension publishing and permissions are complex.
- GPT Actions still expect an HTTPS server URL; this does not directly solve GPT Actions server URL stability unless the GPT client explicitly supports the extension.
- Requires browser-specific integration and user trust.

Best fit:

- Future local UX experiments.
- Optional enhancement, not the primary GPT Actions relay path.

## C. Recommended v1.2 Architecture

Recommended direction: optional **CodexLink Relay**.

```text
GPTs Actions
  -> https://relay.codexlink.example.com
  -> relay session/device pairing
  -> outbound websocket from local launcher
  -> local AgentBridge server
```

The local launcher:

- opens an outbound WebSocket to the relay
- does not require a public inbound port
- does not require quick tunnels
- does not require each user to own a domain
- uses device pairing to bind a GPT session to a local device

The local AgentBridge server remains the source of truth. The relay should only carry bounded, authenticated request/response envelopes.

## D. Pairing Flow

Proposed flow:

1. User runs `start-codexlink.bat`.
2. Launcher creates or loads a local device ID.
3. Launcher opens the GPT URL or a relay pairing page.
4. Relay issues a short-lived pairing code.
5. User pastes the pairing code into GPTs, or GPTs calls `pairDevice`.
6. Relay maps the GPT session to the live device connection.
7. GPT Actions call the stable relay URL.
8. Relay forwards allowed requests to the local launcher over WebSocket.
9. Local launcher forwards to local AgentBridge.
10. Local AgentBridge still enforces bearer/session/project safety.

Pairing should be explicit and revocable. A stale GPT session must not remain bound forever.

## E. Security Model

Required security properties:

- Relay does not store raw file content long-term.
- Relay does not store raw diffs or long raw terminal output.
- Relay only forwards over HTTPS/WSS.
- Local AgentBridge remains the source of truth.
- Device token stays local and is not printed.
- Pairing token is short-lived.
- Per-device project allowlist is enforced.
- Requests are bound to a paired GPT session/device.
- Relay records audit metadata only, with redaction.
- Relay logs are redacted by default.
- Rate limits exist per device, session, IP, and route.
- Origin/session binding prevents random callers from using a paired device.
- No arbitrary command runner is added.
- No raw local token is exposed to GPTs.
- Revocation command exists locally and through relay account/device UI.
- Optional self-host relay mode is supported for advanced users.

Important non-goals:

- No write-file capability in the relay MVP.
- No shell/command execution through relay.
- No OpenAI API key requirement.
- No HTTP `/mcp` endpoint.
- No long-term relay memory of local workspace content.

## F. Minimal MVP

v1.2 MVP should remain conservative:

- This architecture document.
- Local launcher supports a relay mode config placeholder.
- CLI command:

```powershell
node dist\cli.js setup relay --dry-run
```

- No production relay server yet.
- No hosted relay credentials yet.
- Doctor reports relay mode as experimental.

The MVP should teach users the difference between:

- local-only launcher
- stable self-managed tunnel
- future hosted relay

## G. Acceptance Criteria

The v1.2 plan is accepted when:

- User can understand all choices and tradeoffs.
- v1.1 remains stable without relay.
- v1.2 relay plan does not weaken v1.0/v1.1 safety.
- No code path gives GPTs arbitrary local write access.
- No code path gives GPTs arbitrary local shell access.
- No token is printed.
- No OpenAI API key is required.
- No HTTP `/mcp` endpoint is introduced.
- Relay mode is clearly marked optional and experimental until implemented and security-tested.

## H. Future Implementation Phases

### Phase 1: Relay Protocol Spec

- Define request/response envelope.
- Define device identity model.
- Define pairing code lifecycle.
- Define allowed routes.
- Define redaction and truncation requirements.
- Prototype local outbound WebSocket client.

### Phase 2: Self-Host Relay Prototype

- Implement self-host relay server.
- Add pairing code endpoint.
- Add device connection registry.
- Add relay health endpoint.
- Add rate limits and request audit metadata.

### Phase 3: GPT Actions Relay Schema

- Add GPT Actions schema for relay mode.
- Add device binding and session binding.
- Add security tests for unauthorized requests.
- Add replay/expiry tests for pairing codes.
- Add no-secret/no-raw-content relay log tests.

### Phase 4: Launcher End-To-End

- `start-codexlink.bat` can start relay mode.
- Launcher can connect outbound to relay.
- GPTs can pair with a local device.
- GPTs can call project/session summary through relay.
- End-to-end GPTs test passes without quick tunnel or user-owned domain.

## Open Questions

- Should hosted relay be operated by CodexLink maintainers or only self-hosted?
- What account/device model is acceptable without adding team/cloud complexity too early?
- How should users revoke all devices if local config is lost?
- Which routes are safe enough for relay MVP: project list, session summary, context, timeline, inspect, or read-only project browsing?
- Should file read through relay require an extra confirmation or only rely on existing local allowlists?

## Recommendation

Use v1.2 to specify and prototype the relay boundary, not to ship a hosted production relay immediately.

The safest path is:

1. Keep v1.1 launcher stable.
2. Document self-managed stable tunnels as the production path today.
3. Add relay mode as experimental config and doctor checks.
4. Prototype self-host relay first.
5. Only consider hosted relay after pairing, revocation, audit, rate limiting, and no-secret tests pass.
