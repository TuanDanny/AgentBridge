# AgentBridge Project Inspector

## Status

v0.4-beta Project-aware ChatGPT Inspector HTTP endpoints.

v0.4-alpha added CLI-based project inspection. v0.4-beta exposes the same redacted inspector data through token-protected `/chatgpt/projects*` JSON endpoints for local ChatGPT bridge clients.

## Purpose

Project Inspector is AgentBridge Level 3 read/understand capability. It creates a redacted, structured snapshot of the local project so ChatGPT can understand what Codex is working on.

The inspector does not run Codex, does not create tasks, does not push git changes, and does not execute shell commands.

## CLI Usage

Print a human-readable project summary:

```bash
agentbridge inspect
```

Print the full JSON snapshot:

```bash
agentbridge inspect --json
```

Create a Markdown packet for ChatGPT copy/paste:

```bash
agentbridge inspect --for-chatgpt
```

This writes:

```text
.agentbridge/project_inspect_packet.md
```

Focus on changed files and Codex progress/result:

```bash
agentbridge inspect --changes
```

## HTTP Usage

Start the local HTTP bridge:

```bash
agentbridge start --host 127.0.0.1 --port 7777
```

Every `/chatgpt/projects*` request requires the local AgentBridge token. The endpoints are:

```text
GET /chatgpt/projects
GET /chatgpt/projects/:projectId/inspect
GET /chatgpt/projects/:projectId/codex-changes
GET /chatgpt/projects/:projectId/review-packet
```

`GET /chatgpt/projects` returns registered projects when the local project registry has entries. If the registry is empty, it exposes only the current server project as the default project.

`GET /chatgpt/projects/:projectId/inspect` returns the full redacted Project Inspector snapshot.

`GET /chatgpt/projects/:projectId/codex-changes` returns changed files, diff summary, Codex progress, and Codex result summaries.

`GET /chatgpt/projects/:projectId/review-packet` returns a ChatGPT review packet summary derived from the inspector snapshot.

Unknown project IDs return a safe 404. HTTP clients cannot pass arbitrary raw filesystem paths for inspection.

## Included Data

The inspector snapshot includes:

```text
- project id, name, and root hint
- git availability
- branch
- clean/dirty status
- changed files
- changed file summaries
- diff summary
- recent commits
- recent tags when git provides them
- AgentBridge session status
- next_action
- ChatGPT plan summary
- Codex progress summary
- Codex result summary
- review packet summary when present
- latest test log summary when present
- pending approval count
- risk flags from pending approvals
- redaction and truncation metadata
```

## Redaction

Inspector output is treated as ChatGPT-readable and is redacted by default.

It redacts:

```text
local_token values
API keys
GitHub tokens
Cloudflare tokens
passwords
private keys
.env-style secrets
bearer tokens
```

The inspector does not read `.env` files directly. If secret-like values are present in AgentBridge-authored files, Codex result text, plans, progress logs, or git output, they are redacted before output.

## Truncation

Large fields are truncated with this marker:

```text
[TRUNCATED by AgentBridge inspector]
```

The default maximum field size is 6000 characters.

The JSON snapshot reports:

```text
limits.redacted
limits.truncated
limits.truncated_fields
limits.diff_truncated
limits.max_chars_per_field
```

## Not HTTP MCP

Project Inspector is not Streamable HTTP MCP.

`/chatgpt/*` and `/chatgpt/projects*` are still the custom JSON HTTP bridge. They are not MCP protocol.

STDIO MCP remains the verified MCP path:

```bash
agentbridge mcp
```

Streamable HTTP MCP remains deferred until a real MCP SDK transport is implemented and tested. AgentBridge must not fake `/mcp`.

## No API Keys

Project Inspector does not require:

```text
OPENAI_API_KEY
CODEX_API_KEY
```

## Future Phases

v0.4-gamma will add an OpenAPI/tool adapter spec for compatible HTTP clients without including any real token.
