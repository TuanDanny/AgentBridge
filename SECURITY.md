# Security Policy

CodexLink is a local-first bridge for ChatGPT/GPTs, Codex UI, MCP, and local workspace memory. Security reports are welcome.

## Reporting

Please open a private report or contact the maintainer before publishing details for issues that could expose local files, tokens, project data, or relay sessions.

Do not include real secrets in reports. Use fake values such as:

```text
OPENAI_API_KEY=sk-test_should_not_leak
token=abc_should_not_leak
```

## Security Boundaries

- No OpenAI API key is required.
- MCP remains STDIO-only; CodexLink does not expose HTTP `/mcp`.
- GPT Actions and relay routes are read-only metadata/inspector paths.
- No arbitrary command runner is exposed.
- No write/edit/delete file route is exposed.
- Projects must be explicitly registered or selected.
- Relay MVP uses short-lived pairing and per-device project allowlists.
- `.agentbridge/local_token`, `.env`, private keys, and runtime files must not be committed or shared.

## Relay MVP Notes

The hosted relay is an MVP/experimental path for stable GPT Actions endpoints. It stores pairing/session metadata in memory and forwards allowlisted requests to a connected local device over outbound WebSocket. Local AgentBridge remains the source of truth and revalidates requests.
