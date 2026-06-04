# AgentBridge ChatGPT Web Bridge

## Status

v0.2 local HTTP bridge.

## What Already Works

Codex app -> AgentBridge STDIO MCP -> local project.

The STDIO MCP path remains the accepted Codex integration path.

## What This Adds

AgentBridge exposes token-protected local JSON endpoints under `/chatgpt/*` for ChatGPT web, browser helper, tunnel, future connector, or future HTTP MCP preparation.

This phase does not make ChatGPT web directly call localhost by itself.

## Important Limitation

ChatGPT web may not directly access localhost. A secure tunnel, ChatGPT connector, browser helper, or Streamable HTTP MCP setup may be needed later.

Streamable HTTP MCP is deferred to v0.3 because the accepted v0.2 deliverable is the local `/chatgpt/*` bridge, and the STDIO MCP server must remain stable.

## Security

Do not expose this server publicly without authentication and tunnel hardening.

Never share `.agentbridge/local_token`.

All non-health endpoints require the local token via one of these headers:

```text
Authorization: Bearer <token>
x-agentbridge-token: <token>
```

`/health` is public and only returns liveness metadata.

Request bodies and returned project text are redacted before storage or response where sensitive text may appear.

## Endpoints

```text
GET  /chatgpt/session-summary
GET  /chatgpt/repo-status
GET  /chatgpt/context
GET  /chatgpt/next-task
GET  /chatgpt/review-packet
POST /chatgpt/create-codex-prompt
POST /chatgpt/report-progress
POST /chatgpt/submit-codex-result
POST /chatgpt/classify-command
POST /chatgpt/request-approval
```

## Manual Tests

Build and run the automated tests:

```powershell
cd D:\AgentBridge
npm run build
npm test
```

Start the daemon:

```powershell
node dist\cli.js start
```

Read the local token:

```powershell
$token = Get-Content .agentbridge\local_token
```

Check health without a token:

```powershell
curl http://127.0.0.1:7777/health
```

Check that ChatGPT bridge endpoints reject unauthenticated requests:

```powershell
curl http://127.0.0.1:7777/chatgpt/session-summary
```

Call the bridge with the token:

```powershell
curl -H "Authorization: Bearer $token" http://127.0.0.1:7777/chatgpt/session-summary
curl -H "Authorization: Bearer $token" http://127.0.0.1:7777/chatgpt/repo-status
curl -H "Authorization: Bearer $token" http://127.0.0.1:7777/chatgpt/context
curl -H "Authorization: Bearer $token" http://127.0.0.1:7777/chatgpt/next-task
```

Classify a risky command without running it:

```powershell
$body = '{"command":"rm -rf node_modules"}'
curl -Method POST `
  -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
  -Body $body `
  http://127.0.0.1:7777/chatgpt/classify-command
```

Expected classifier fields:

```json
{
  "ok": true,
  "risk": "high",
  "requiresApproval": true,
  "blocked": true
}
```

## Next Phase

Implement Streamable HTTP MCP or secure tunnel support after confirming the SDK/client integration path and authentication requirements.
