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

Register and list projects:

```bash
agentbridge projects add
agentbridge projects list
agentbridge projects remove "D:\\path\\to\\project"
```

The registry is stored under the OS user data directory by default. Override it for testing or portable setups:

```bash
AGENTBRIDGE_HOME=/path/to/agentbridge-home agentbridge projects list
```

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
