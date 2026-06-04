# AgentBridge ChatGPT Web Bridge Acceptance

Verification date: 2026-06-01

## Automated Checks

```text
npm run build: pass
npm test: pass
```

Vitest result:

```text
Test Files: 8 passed
Tests: 27 passed
```

## Manual HTTP Checks

Daemon command:

```powershell
node dist\cli.js start --host 127.0.0.1 --port 7777
```

Results:

```json
{
  "health_ok": true,
  "unauthorized_status": "401",
  "session_ok": true,
  "repo_ok": true,
  "context_ok": true,
  "next_task_ok": true,
  "classify_risk": "high",
  "classify_requiresApproval": true,
  "classify_blocked": true
}
```

## Acceptance Checklist

```text
[x] npm run build passes
[x] npm test passes
[x] /health works without token
[x] /chatgpt/session-summary returns 401 without token
[x] /chatgpt/session-summary works with token
[x] /chatgpt/repo-status works with token
[x] /chatgpt/context works with token
[x] /chatgpt/next-task works with token
[x] /chatgpt/classify-command blocks rm -rf node_modules
[x] Existing STDIO MCP tests still pass
[x] docs/guides/CHATGPT_WEB_BRIDGE.md exists
[x] README.md updated
[x] No API key required
[x] No cloud/team mode added
```

## HTTP MCP

Deferred to v0.3. The v0.2 deliverable is the token-protected `/chatgpt/*` HTTP bridge while preserving the accepted STDIO MCP flow.
