# AgentBridge Project Inspector Acceptance

Verification date: 2026-06-01

## Scope

v0.4-alpha Project Inspector Core, v0.4-beta Project-aware ChatGPT Inspector HTTP endpoints, and v0.4-gamma ChatGPT Tool Adapter spec.

The HTTP endpoints and OpenAPI adapter are custom `/chatgpt/*` JSON bridge surfaces. They are not Streamable HTTP MCP and do not add `/mcp`.

## Automated Checks

```text
npm run build: pass
npm test: pass
git diff --check: pass
Test Files: 12 passed
Tests: 51 passed
```

## Manual CLI Smoke

```text
node dist\cli.js inspect: pass
node dist\cli.js inspect --json: pass
node dist\cli.js inspect --changes: pass
node dist\cli.js inspect --for-chatgpt: pass
```

## HTTP Endpoint Checks

```text
GET /chatgpt/projects without token: pass, returns 401
GET /chatgpt/projects/:projectId/inspect without token: pass, returns 401
GET /chatgpt/projects/:projectId/codex-changes without token: pass, returns 401
GET /chatgpt/projects/:projectId/review-packet without token: pass, returns 401
GET /chatgpt/projects with token: pass, returns projects
GET /chatgpt/projects/:projectId/inspect with token: pass, returns inspector snapshot
GET /chatgpt/projects/:projectId/codex-changes with token: pass, returns changed file summary
GET /chatgpt/projects/:projectId/review-packet with token: pass, returns redacted review packet
GET /chatgpt/projects/unknown/inspect with token: pass, returns safe 404
```

## Acceptance Checklist

```text
[x] npm run build pass
[x] npm test pass
[x] git diff --check pass
[x] agentbridge inspect prints human-readable summary
[x] agentbridge inspect --json prints JSON snapshot
[x] agentbridge inspect --for-chatgpt creates .agentbridge/project_inspect_packet.md
[x] agentbridge inspect --changes prints Codex changes summary
[x] snapshot includes project/repo/session fields
[x] snapshot captures changed files
[x] non-git projects do not report fake changed files
[x] snapshot includes Codex progress/result when present
[x] snapshot includes pending approvals count
[x] token-like values are redacted
[x] local_token exact value is redacted if present in inspected content
[x] private key blocks are redacted
[x] large content is truncated with a clear marker
[x] existing STDIO MCP tests still pass
[x] existing /chatgpt/* bridge tests still pass
[x] existing group/tunnel tests still pass
[x] GET /chatgpt/projects without token returns 401
[x] GET /chatgpt/projects/:projectId/inspect without token returns 401
[x] GET /chatgpt/projects/:projectId/codex-changes without token returns 401
[x] GET /chatgpt/projects/:projectId/review-packet without token returns 401
[x] GET /chatgpt/projects with token returns project list
[x] inspect endpoint returns project, repo, Codex, and session fields
[x] unknown project ID returns safe 404
[x] codex-changes endpoint returns changed file and Codex summaries
[x] review-packet endpoint returns redacted packet summary
[x] registry projects are used when registered projects exist
[x] registered projects with duplicate names receive distinct safe IDs
[x] current project is exposed only as default when registry is empty
[x] HTTP inspection does not accept arbitrary raw filesystem paths
[x] openapi.agentbridge.json parses as JSON
[x] openapi.agentbridge.json includes listProjects
[x] openapi.agentbridge.json includes inspectProject
[x] openapi.agentbridge.json includes getCodexChanges
[x] openapi.agentbridge.json includes getReviewPacket
[x] openapi.agentbridge.json uses bearer auth
[x] openapi.agentbridge.json uses placeholder tunnel URL only
[x] openapi.agentbridge.json contains no token value
[x] no HTTP MCP implemented
[x] no fake /mcp added
[x] no OpenAI API key required
[x] no cloud/team/account mode added
```

## Deferred

```text
- v0.4-gamma OpenAPI/tool adapter
- Streamable HTTP MCP
- autonomous Codex loop
```
