# AgentBridge Spec

## Product Definition

AgentBridge is a local bridge between ChatGPT, Codex, and a local repository. It does not replace ChatGPT or Codex. It provides a shared session, a normalized task protocol, local context capture, and safety boundaries.

## Phase 0+1 Scope

This implementation covers:

- A TypeScript/npm CLI package named `agentbridge`.
- A file-based shared session stored in `.agentbridge/`.
- Local git status and diff capture.
- Codex prompt generation from user intent, project context, and ChatGPT plan.
- Result and review packet templates.
- Secret redaction for captured text.
- Audit events for CLI actions.
- A local HTTP daemon on `127.0.0.1:7777` by default.
- Token-protected local endpoints for session, context, git state, plans, results, progress, and approval status.
- A stdio MCP server exposing the minimum AgentBridge tool set.
- A command risk classifier and local approval queue.
- A local web dashboard served by the daemon at `/dashboard`.
- A Codex adapter for copy/open/explicit-run prompt handoff.
- A multi-project registry and local pairing URL/QR helper.

This implementation does not include:

- Automatic Codex execution.
- Background Codex automation without explicit `--run`.
- OpenAI API calls or API key authentication.

## User Flow

```text
User writes intent in .agentbridge/user_intent.md
ChatGPT writes or helps create .agentbridge/chatgpt_plan.md
AgentBridge captures project context
AgentBridge creates .agentbridge/codex_prompt.md
Codex uses the prompt to work in the repo
User or Codex fills .agentbridge/codex_result.md
AgentBridge creates .agentbridge/chatgpt_review.md
ChatGPT reviews the result and suggests next action
```

## Source Of Truth

The `.agentbridge/` folder is the source of truth for the current task session. Git state is read-only input. The CLI should remain useful even outside a git repository, but git fields must clearly report that git is unavailable.

## Default Safety Posture

- Do not require an API key.
- Do not read known secret files into generated context.
- Redact token-like values from captured output.
- Do not run destructive commands.
- Do not push, commit, or mutate git history.
- Log CLI actions to `.agentbridge/audit.jsonl`.
- Bind the daemon to localhost by default.
- Require the local token for every data endpoint except `/health`.
- Classify risky commands before future automation can execute them.
- Store user approval state locally in `.agentbridge/approvals.json`.

## Local Daemon Contract

The daemon runs in the foreground with:

```bash
agentbridge start
```

It writes runtime metadata to `.agentbridge/server.json` and a local token to `.agentbridge/local_token`. The token is accepted through either:

```text
Authorization: Bearer <token>
x-agentbridge-token: <token>
```

Endpoints:

```text
GET  /health
GET  /context
GET  /session
GET  /repo/status
GET  /repo/diff
GET  /tests/latest
GET  /codex/progress
POST /chatgpt/plan
POST /codex/result
POST /approve
POST /reject
POST /shutdown
```

The daemon also serves `/dashboard`, a local web UI for session status, plan, Codex task/progress/result, changed files, test status, and pending approvals.

## Safety And Approval Contract

The CLI and MCP server can classify command risk without executing the command. Medium and high risk commands require approval. Some high-risk commands, such as recursive force delete and disk formatting patterns, are marked blocked.

Approval items use:

```json
{
  "id": "appr_...",
  "actor": "codex",
  "action": "run_command",
  "command": "git push --force",
  "risk": "high",
  "status": "pending",
  "created_at": "2026-06-01T00:00:00.000Z",
  "updated_at": "2026-06-01T00:00:00.000Z"
}
```

## Codex Adapter Contract

The adapter supports:

```text
agentbridge codex --copy
agentbridge codex --open
agentbridge codex --run
agentbridge codex --run --dry-run
```

`--copy` is the default behavior. `--run` is never implied; it must be explicitly requested. The default run shape is `codex exec "<prompt>"`, with `--codex-command` and `AGENTBRIDGE_CODEX_ARGS` available for local CLI differences.

## Multi-Project And Pairing Contract

The project registry is explicit and local:

```text
agentbridge projects add
agentbridge projects list
agentbridge projects remove <path>
```

The registry stores project root, bridge directory, session id, current status, next action, and last seen timestamp. `AGENTBRIDGE_HOME` can override the user data directory.

Pairing prints a dashboard URL and can render an ASCII QR code:

```text
agentbridge pair --host <LAN_IP> --port 7777 --qr
```

Phone access requires the daemon to be bound to a LAN-reachable host, such as `0.0.0.0`.

## Future Phases

Phase 4 hardens approval and safety. Phase 5 adds a local dashboard.
