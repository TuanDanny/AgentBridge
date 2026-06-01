# AgentBridge Secure Tunnel Bridge Acceptance

Verification date: 2026-06-01

## Automated Checks

```text
npm run build: pass
npm test: pass
Test Files: 10 passed
Tests: 37 passed
```

Tunnel endpoint testing is covered by `test/tunnel.test.ts` with a fake local HTTP server.

## Manual CLI Smoke

```json
{
  "guide_mentions_cloudflared": true,
  "guide_mentions_ngrok": true,
  "http_rejected_by_default": true,
  "https_registered": true,
  "remote_bridge_created": true,
  "remote_bridge_has_no_token": true,
  "status_hides_token": true
}
```

## Acceptance Checklist

```text
[x] npm run build pass
[x] npm test pass
[x] agentbridge tunnel guide prints daemon, cloudflared, ngrok, register, and test steps
[x] tunnel register accepts https:// by default
[x] tunnel register rejects http:// by default
[x] tunnel register accepts http:// only with --allow-insecure
[x] .agentbridge/remote_bridge.json is created
[x] remote_bridge.json does not contain local token
[x] tunnel status does not print full token
[x] tunnel status reports token exists yes/no only
[x] tunnel test checks /health
[x] tunnel test checks /chatgpt/session-summary without token returns 401
[x] tunnel test checks /chatgpt/session-summary with token
[x] tunnel test checks /chatgpt/repo-status with token
[x] tunnel test checks /chatgpt/classify-command blocks rm -rf node_modules
[x] docs warn not to expose token or tunnel publicly
[x] no OpenAI API key required
[x] no cloud/team/account mode added
```

## Notes

The automated tunnel test uses a fake local HTTP server so CI and local tests do not require a real internet tunnel.

Manual public tunnel verification requires a user-managed `cloudflared` or `ngrok` tunnel.
