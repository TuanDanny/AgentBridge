# AgentBridge HTTP MCP Acceptance

Verification date: 2026-06-01

## Status

Deferred.

Streamable HTTP MCP is not implemented in v0.3-gamma. No `/mcp` endpoint is claimed as working.

## Existing Verified Paths

```text
[x] v0.1 STDIO MCP verified
[x] v0.2 /chatgpt/* HTTP JSON bridge verified
[x] v0.3-beta Secure Tunnel Bridge verified
```

## HTTP MCP Checklist

```text
[x] No fake /mcp endpoint added
[x] /chatgpt/* JSON bridge is documented as not MCP protocol
[x] Future work requires real MCP SDK Streamable HTTP transport
[x] Security requirements documented
[x] No API key required
[x] No public unauthenticated tools added
[x] STDIO MCP remains the accepted MCP path
[ ] Real Streamable HTTP MCP transport implemented
[ ] MCP HTTP handshake tested
[ ] tools/list over HTTP MCP tested
[ ] tools/call get_repo_status over HTTP MCP tested
[ ] tools/call get_project_context over HTTP MCP tested
[ ] tools/call classify_command over HTTP MCP tested
```

## Reason For Deferral

The current v0.3-gamma step is documentation-only. Implementing HTTP MCP requires a real MCP SDK Streamable HTTP transport integration and client-level protocol tests. AgentBridge must not present ordinary JSON endpoints as MCP.

## Acceptance Result

PASS as deferred documentation.

This is not a PASS for implemented HTTP MCP.
