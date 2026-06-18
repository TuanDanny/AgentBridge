# AgentBridge Streamable HTTP MCP

## Status

Deferred for v0.3-gamma.

AgentBridge does not currently implement Streamable HTTP MCP. There is no working `/mcp` HTTP endpoint, and this document must not be read as a claim that HTTP MCP is available.

## Verified Existing Paths

v0.1 STDIO MCP is verified:

```text
Codex app -> node dist/cli.js mcp -> StdioServerTransport
```

The accepted STDIO MCP tools include:

```text
get_project_context
get_session_summary
create_codex_prompt
get_next_task
report_progress
submit_codex_result
review_codex_result
request_user_approval
get_repo_status
classify_command
```

v0.2 `/chatgpt/*` HTTP JSON bridge is verified and token-protected.

v0.3-beta Secure Tunnel Bridge is verified as a workflow for exposing the existing local HTTP JSON bridge through a user-managed HTTPS tunnel.

## Important Distinction

`/chatgpt/*` endpoints are custom JSON bridge endpoints. They are not MCP protocol endpoints.

A tunnel URL that exposes `/chatgpt/*` does not make AgentBridge an HTTP MCP server.

Streamable HTTP MCP requires the real MCP protocol transport, handshake, session behavior, and tool call semantics from the MCP SDK or an equivalent supported implementation.

## Deferred Scope

This phase intentionally does not:

```text
- add /mcp
- add agentbridge mcp-http
- fake tools/list or tools/call with ordinary JSON routes
- claim /chatgpt/* is MCP
- replace STDIO MCP
```

## Future Work

Implement real Streamable HTTP MCP only after confirming the current MCP SDK transport support and client compatibility.

Future implementation requirements:

```text
1. Reuse createAgentBridgeMcpServer(rootInput) tool definitions.
2. Use the official MCP Streamable HTTP transport or another supported MCP SDK mechanism.
3. Require token auth or a documented equivalent secure auth strategy.
4. Keep /health public only for liveness.
5. Keep /chatgpt/* token-protected.
6. Preserve STDIO MCP behavior and tests.
7. Add MCP client tests for handshake, tools/list, and tools/call.
8. Verify get_repo_status, get_project_context, and classify_command over HTTP MCP.
9. Document exact endpoint, auth, limitations, and client setup.
```

## Security Requirements

Any future HTTP MCP implementation must follow these rules:

```text
- no OpenAI API key required
- no CODEX_API_KEY required
- no public unauthenticated tools
- no exposed .agentbridge/local_token
- no secrets in logs, docs, prompts, or tunnel status
- no cloud/team/account mode implied by the local HTTP transport
- classify_command must continue to block rm -rf node_modules
```

Until that work is complete, use STDIO MCP for Codex and `/chatgpt/*` for the token-protected HTTP JSON bridge.
