# CodexLink v0.7 Setup And Doctor

CodexLink v0.7 is a local-first workflow. Codex uses the local plugin and MCP over stdio. GPT Actions use the HTTPS tunnel and bearer auth. No OpenAI API key is required.

## Quickstart

```powershell
npm run build
node dist\cli.js setup codex-plugin --dry-run
node dist\cli.js doctor
```

Then in Codex:

1. Enable the repo-local CodexLink plugin.
2. Review and trust the `SessionStart` hook once.
3. Open a new Codex chat in a registered project.
4. Confirm the hook reports a `session_bootstrap` status.

## Plugin Setup

```powershell
node dist\cli.js setup codex-plugin
node plugins\codexlink\hooks\session_start.mjs --dry-run
```

The setup command validates:

- `plugins/codexlink/.codex-plugin/plugin.json`
- `plugins/codexlink/.mcp.json`
- `plugins/codexlink/hooks/hooks.json`
- `.agents/plugins/marketplace.json`
- skill and hook files

The hook does not read or print bearer tokens. Hook trust is still a manual Codex UI step.

## GPT Actions Setup

```powershell
node dist\cli.js setup gpt-actions
```

This regenerates OpenAPI schemas and, when a tunnel is registered, writes a live GPT Actions schema under `.agentbridge/`. It does not print token values. If a quick tunnel expires, start a fresh tunnel and run setup again.

## Doctor

```powershell
node dist\cli.js doctor
node dist\cli.js doctor --json
node dist\cli.js doctor --project AgentBridge
```

Doctor checks Node, build artifacts, package scripts, plugin JSON, marketplace, hook dry-run, OpenAPI request bodies, session bootstrap, local server health, tunnel health, and whether session runtime files appear in git status.

`doctor --json` returns:

```json
{
  "ok": true,
  "checks": [
    {
      "name": "hook_dry_run",
      "status": "PASS",
      "message": "SessionStart hook dry-run reports session_bootstrap.",
      "next_step": "No action needed."
    }
  ]
}
```

## Common Failures

- `ClientResponseError`: check the tunnel URL, bearer auth, and whether AgentBridge is running.
- Tunnel `502`: local AgentBridge server is down or unreachable from the tunnel.
- Tunnel `530`: Cloudflare quick tunnel is likely stale.
- Server not running: run `node dist\cli.js start --host 127.0.0.1 --port 7777`.
- Project not registered: run `node dist\cli.js project register-current <id>` or select a registered project.
- MCP/plugin missing: run `node dist\cli.js setup codex-plugin --dry-run`, then enable the plugin.
- Schema import error: run `npm run generate:openapi` and re-import the GPT Actions schema.
- Hook not trusted: review and trust the `SessionStart` hook in Codex UI.

## Security Notes

- Do not paste bearer tokens into chat.
- Do not commit `.agentbridge/` runtime files.
- Do not expose `/chatgpt/*` without bearer auth.
- `/chatgpt/*` JSON endpoints are not MCP protocol.
- HTTP `/mcp` remains intentionally unimplemented.
