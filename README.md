# AgentBridge

AgentBridge is a local shared-session bridge that helps ChatGPT and Codex work from the same task context. This Phase 0+1 build is intentionally file-based: it writes a `.agentbridge/` folder inside the current project and never calls the OpenAI API.

## Install And Build

```bash
npm install
npm run build
```

Run the CLI from this repository:

```bash
node dist/cli.js --help
```

After publishing or linking, the binary name is:

```bash
agentbridge
```

## Phase 1 Workflow

Initialize a project:

```bash
agentbridge init
```

Capture project context:

```bash
agentbridge capture --mode short
agentbridge capture --mode full
agentbridge capture --mode raw
```

Create a Codex prompt from `user_intent.md`, `project_context.md`, and `chatgpt_plan.md`:

```bash
agentbridge prompt
```

Prepare a result template after Codex works:

```bash
agentbridge result
```

Prepare a ChatGPT review packet:

```bash
agentbridge review
```

Inspect the current shared session:

```bash
agentbridge status
```

## Shared Folder

AgentBridge creates:

```text
.agentbridge/
  config.toml
  session.json
  user_intent.md
  project_context.md
  chatgpt_plan.md
  codex_prompt.md
  codex_progress.md
  codex_result.md
  chatgpt_review.md
  group_brief.md
  group_handoff.md
  group_decision.md
  remote_bridge.json
  project_inspect_packet.md
  next_action.md
  approvals.json
  approval_queue.jsonl
  audit.jsonl
  snapshots/
  logs/
```

User-authored files such as `user_intent.md`, `chatgpt_plan.md`, and `codex_result.md` are created only when missing. Generated files such as `project_context.md`, `codex_prompt.md`, and `chatgpt_review.md` may be replaced by their commands.

## No API Key By Default

## Phase 2 Local Daemon

Start a local HTTP daemon in the foreground:

```bash
agentbridge start
```

Use a custom port if needed:

```bash
agentbridge start --host 127.0.0.1 --port 7777
```

Stop it from another terminal:

```bash
agentbridge stop
```

The daemon writes `.agentbridge/server.json` and a local `.agentbridge/local_token`. All endpoints except `/health` require the token via `Authorization: Bearer <token>` or `x-agentbridge-token`. `/health` is intentionally public and returns only basic liveness data.

Implemented endpoints:

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

Open the local dashboard while the daemon is running:

```text
http://127.0.0.1:7777/dashboard
```

The dashboard endpoint is token-protected like the other non-health endpoints.

Dashboard actions use these additional local endpoints:

```text
GET  /chatgpt/plan
GET  /codex/task
GET  /codex/result
GET  /approvals
POST /codex/prompt
POST /review
POST /approval/request
```

## Phase 3 MCP Server

Run the MCP server over stdio:

```bash
agentbridge mcp
```

Minimum tools implemented:

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

The MCP server reads and writes the same `.agentbridge/` shared session as the CLI and daemon. It does not call OpenAI APIs.

## Phase 8 ChatGPT Web Bridge

AgentBridge now exposes token-protected local HTTP endpoints under `/chatgpt/*` for browser and ChatGPT-web bridge preparation.

This does not require OpenAI API keys. It does not replace the accepted Codex STDIO MCP flow.

Implemented ChatGPT bridge endpoints:

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

See `CHATGPT_WEB_BRIDGE.md` for usage, security notes, and manual curl checks.

## v0.3-alpha Group Chat Companion

AgentBridge can create redacted Markdown packets for ChatGPT group chat coordination. Group chat is only a coordination layer; AgentBridge remains the source of truth.

Commands:

```text
agentbridge group brief
agentbridge group handoff
agentbridge group decision-template
agentbridge group apply-decision
agentbridge group status
```

Generated files:

```text
.agentbridge/group_brief.md
.agentbridge/group_handoff.md
.agentbridge/group_decision.md
```

`group apply-decision` reads the local decision file, redacts secret-like values, updates `chatgpt_plan.md` and `next_action.md`, regenerates `codex_prompt.md`, and records `group.apply_decision` in the audit log. It does not run Codex.

See `GROUP_CHAT_COMPANION.md` for the workflow and safety notes.

## v0.3-beta Secure Tunnel Bridge

AgentBridge can register and test a user-managed HTTPS tunnel that forwards to the local HTTP daemon. This is local-first tunnel preparation, not cloud/team/account mode.

Commands:

```text
agentbridge tunnel guide
agentbridge tunnel register <public-url>
agentbridge tunnel status
agentbridge tunnel test
```

Default behavior:

```text
- tunnel register accepts https:// URLs.
- tunnel register rejects http:// URLs unless --allow-insecure is set.
- .agentbridge/remote_bridge.json stores public_url and local_url only.
- tunnel status never prints the full local token.
- tunnel test checks /health, /chatgpt auth, repo status, and command safety.
```

Do not share `.agentbridge/local_token`. Do not commit `.agentbridge/remote_bridge.json` if it contains a private tunnel URL.

See `SECURE_TUNNEL_BRIDGE.md` for setup steps and security notes.

## v0.3-gamma Streamable HTTP MCP

Streamable HTTP MCP is deferred. AgentBridge does not claim a working `/mcp` HTTP endpoint, and `/chatgpt/*` remains a custom JSON bridge rather than MCP protocol.

Use the verified STDIO MCP path for MCP clients. Future HTTP MCP work must use a real MCP SDK Streamable HTTP transport with token auth and protocol-level tests.

See `STREAMABLE_HTTP_MCP.md` and `HTTP_MCP_ACCEPTANCE.md` for the deferred status.

## v0.4 Project Inspector

AgentBridge can create a redacted, truncated project inspector snapshot for ChatGPT-readable local project status. This is Level 3 read/understand capability, not an autonomous Codex loop.

Commands:

```text
agentbridge inspect
agentbridge inspect --json
agentbridge inspect --for-chatgpt
agentbridge inspect --changes
```

The inspector includes repo state, changed files, AgentBridge session state, ChatGPT plan summary, Codex progress/result summaries, latest test summary when present, and pending approval count.

`agentbridge inspect --for-chatgpt` writes `.agentbridge/project_inspect_packet.md`.

Project-aware HTTP endpoints are available through the existing token-protected JSON bridge:

```text
GET /chatgpt/projects
GET /chatgpt/projects/:projectId/inspect
GET /chatgpt/projects/:projectId/codex-changes
GET /chatgpt/projects/:projectId/review-packet
```

When the local project registry is empty, the HTTP bridge exposes only the current project as the default project. It does not accept arbitrary raw filesystem paths.

This is not HTTP MCP and does not add `/mcp`.

v0.4-gamma adds a ChatGPT Tool Adapter spec for compatible HTTP tool/action clients:

```text
openapi.agentbridge.json
```

The spec uses a placeholder server URL, `https://YOUR-TUNNEL-URL.example`, and bearer auth. It does not include a real local token and does not require an API key. ChatGPT direct use depends on whether the current client/tool can import the spec, reach the HTTPS tunnel, and attach the bearer token securely.

Fallback remains:

```text
agentbridge inspect --for-chatgpt
```

See `INSPECTOR.md` and `CHATGPT_TOOL_ADAPTER.md` for usage and safety details.

## v0.5 Project Registry And Picker

AgentBridge can expose multiple explicitly registered local projects to ChatGPT/GPT Actions. The registry is local-only:

```text
.agentbridge/projects.json
```

Register projects:

```text
agentbridge project register AgentBridge D:\AgentBridge
agentbridge project register-current AgentBridge
agentbridge project list
agentbridge project inspect AgentBridge
agentbridge project remove AgentBridge
```

v0.5-beta safe project discovery scans a user-selected folder, previews strong-marker project candidates, and registers selected projects:

```text
agentbridge project scan D:\Projects --preview
agentbridge project scan D:\Projects --register --select 1,3
agentbridge project scan D:\Projects --register
```

The scan is CLI-only, bounded by `--max-depth` and `--max-projects`, and does not scan the whole machine. It does not add a `/chatgpt/scan` endpoint.

`GET /chatgpt/projects` now returns `mode: "registry"` when registered projects exist, or `mode: "current_project_fallback"` when the registry is empty. GPTs should call `listProjects`, show a lightweight project picker, then inspect only the project selected by the user.

Project IDs are safe identifiers returned by `listProjects`; HTTP endpoints do not accept raw filesystem paths. Users explicitly choose which project roots to expose. Codex app workspace auto-discovery is not implemented in v0.5-beta.

v0.5-gamma adds a safe project tree and file reader for registered projects:

```text
agentbridge project tree AgentBridge --json
agentbridge project find-file AgentBridge README --json
agentbridge project read-file AgentBridge README.md --json
agentbridge project grep AgentBridge "search text" --json
```

HTTP/GPT Actions:

```text
GET /chatgpt/projects/:projectId/tree
GET /chatgpt/projects/:projectId/files/search
GET /chatgpt/projects/:projectId/file
GET /chatgpt/projects/:projectId/grep
```

Paths for file reads are project-relative only. Absolute paths, traversal, secret files, binary files, and oversized reads are rejected or limited.

v0.5-delta adds active project selection:

```text
agentbridge project select AgentBridge
agentbridge project active
agentbridge project clear-active
GET  /chatgpt/active-project
POST /chatgpt/projects/:projectId/select
```

The active project file stores only local selection metadata and no token/auth values.

See `PROJECT_REGISTRY.md` for the full registry and picker flow.

## Phase 4 Safety And Approvals

Classify a command without running it:

```bash
agentbridge safety classify "git push --force"
```

Manage approval requests:

```bash
agentbridge approvals request --action run_command --command "git push --force"
agentbridge approvals list --status pending
agentbridge approvals approve appr_...
agentbridge approvals reject appr_...
```

Approval state is stored in `.agentbridge/approvals.json` and mirrored to `.agentbridge/approval_queue.jsonl` for an append-only trail.

## Phase 6 Codex Adapter

Copy the current Codex prompt to the clipboard:

```bash
agentbridge codex --copy
```

Open the prompt file:

```bash
agentbridge codex --open
```

Run Codex explicitly:

```bash
agentbridge codex --run
```

Preview the command without launching Codex:

```bash
agentbridge codex --run --dry-run
```

By default, `agentbridge codex` behaves like `agentbridge codex --copy`. The run command defaults to `codex exec "<prompt>"` and can be overridden with `--codex-command` or `AGENTBRIDGE_CODEX_ARGS`.

## Phase 7 Multi-Project And Pairing

Register and list explicitly allowed local projects:

```bash
agentbridge project register-current AgentBridge
agentbridge project register CoreWeaver D:\CoreWeaver
agentbridge project list
agentbridge project remove CoreWeaver
```

The registry is stored in `.agentbridge/projects.json` under the current AgentBridge root and is ignored by git. The older `agentbridge projects ...` command remains as a local alias, but `agentbridge project ...` is the v0.5 command set.

Print a dashboard URL for another device:

```bash
agentbridge pair --host 192.168.1.10 --port 7777
agentbridge pair --host 192.168.1.10 --port 7777 --qr
```

For phone access, start the daemon with a LAN-reachable host, for example:

```bash
agentbridge start --host 0.0.0.0 --port 7777
```

## No API Key By Default

This build does not require:

```bash
OPENAI_API_KEY=...
CODEX_API_KEY=...
```

AgentBridge only reads local files, local git metadata, and writes local `.agentbridge/` session files.
