# CodexLink

**CodexLink** is a local-first bridge between ChatGPT/GPTs, Codex UI, MCP, CLI, and local project workspaces.

The backend/package name is still `agentbridge`, but the product name is **CodexLink**. Version `1.0.0` is the stable local workspace memory release: it lets GPTs and Codex understand not only final handoffs, but also recent activity, checks, evidence, workspace snapshots, changed files, and task timelines.

---

## What It Can Do

- Register explicit local projects.
- List and select active projects.
- Safely inspect project tree, file names, text files, and grep results.
- Keep shared session memory across ChatGPT/GPTs, Codex, MCP, and CLI.
- Track Activity Trace through `recent_activity` and `activity_counts`.
- Record handoff lifecycle metadata.
- Record evidence and check metadata.
- Record workspace snapshots.
- Record changed-files summaries.
- Detect activity gaps when files changed without matching recent activity.
- Build timelines by recent activity, handoff, file, or task.
- Return compact resume context for GPTs/Codex.
- Verify safe file metadata without storing file content.
- Bootstrap Codex sessions through the local Codex plugin `SessionStart` hook.
- Expose MCP tools for shared session coordination over STDIO.

---

## Quick Start On A New Machine

```powershell
git clone https://github.com/TuanDanny/AgentBridge.git
cd AgentBridge
.\setup-codexlink-first-time.bat
```

The first-time setup script checks Node/npm, optionally pulls the latest `main`, installs dependencies, builds `dist/`, registers the current repo as a project, creates launcher config, and can start CodexLink.

For automation or a no-prompt setup check:

```powershell
.\setup-codexlink-first-time.bat --defaults --no-start
```

If you prefer manual setup:

```powershell
npm install
npm run build
node dist\cli.js project register-current AgentBridge
.\start-codexlink.bat
```

The local server creates:

```text
.agentbridge/local_token
```

Do not commit, print, or share this token.

---

## One-Click Daily Launcher

After install/build, daily use can be:

```powershell
.\start-codexlink.bat
```

On first run, the launcher creates local launcher config if it is missing. It starts the local server, waits for `/health`, bootstraps the shared session if configured, copies a GPT greeting prompt, and can open your configured GPT URL.

For GPT Actions to call back without URL changes, configure a stable HTTPS endpoint:

```powershell
node dist\cli.js setup launcher --project AgentBridge --public-url https://codexlink.example.com --gpt-url https://chatgpt.com/g/YOUR-GPT
node dist\cli.js setup gpt-actions --public-url https://codexlink.example.com
```

Quick tunnel URLs are temporary and may require schema updates.

Relay planning placeholder:

```powershell
node dist\cli.js setup relay --dry-run
node dist\cli.js relay spec
node dist\cli.js relay pairing create
node dist\cli.js relay serve --experimental
```

Relay mode is not production yet; it is the planned v1.2 path toward zero-setup GPT Actions without user-managed tunnels.

Relay GPT Actions schema prototype:

```text
openapi.codexlink.relay.gpt-actions.json
```

Use the regular `openapi.agentbridge.gpt-actions.json` for direct stable tunnel/domain setup today. The relay schema is for a future trusted relay origin and paired metadata routes only.

Guide: `docs/guides/CODEXLINK_ONE_CLICK_LAUNCHER.md`

Backlog for zero-setup stable relay mode: `docs/architecture/CODEXLINK_ZERO_SETUP_RELAY_PLAN.md`

v1.2 roadmap: `docs/architecture/CODEXLINK_V1_2_ZERO_SETUP_ROADMAP.md`

---

## Register A Local Project

Register an explicit project root:

```powershell
node dist\cli.js project register MyProject D:\Projects\MyProject
node dist\cli.js project list
node dist\cli.js project select MyProject
```

Register the current repo:

```powershell
node dist\cli.js project register-current AgentBridge
```

CodexLink only exposes projects you register or scan-confirm. It does not scan your whole machine automatically.

---

## Shared Session And Activity Usage

```powershell
node dist\cli.js session bootstrap MyProject --source manual --json
node dist\cli.js session activity MyProject --json
node dist\cli.js session timeline MyProject --recent --json
node dist\cli.js session context MyProject --compact --json
node dist\cli.js session reconcile MyProject --json
node dist\cli.js session file-verify MyProject --path README.md --json
```

Useful timeline filters:

```powershell
node dist\cli.js session timeline MyProject --handoff handoff_000001 --json
node dist\cli.js session timeline MyProject --file src/example.ts --json
node dist\cli.js session timeline MyProject --task task-123 --json
```

---

## Safe Project Browsing

```powershell
node dist\cli.js project tree MyProject --json
node dist\cli.js project find-file MyProject README --json
node dist\cli.js project read-file MyProject README.md --json
node dist\cli.js project grep MyProject "readProjectFile" --json
node dist\cli.js project inspect MyProject --json
```

Safe readers use project-relative paths only.

---

## GPT Actions Setup

Generate a GPT Actions-ready schema:

```powershell
.\scripts\prepare-gpt-action.ps1
```

Then in GPT Builder:

```text
Actions -> paste schema -> Authentication: API Key / Bearer -> paste local token -> Save -> Update GPT
```

Important:

- Paste only the token value.
- Do not paste `Bearer <token>`.
- Do not commit or share `.agentbridge/local_token`.
- Cloudflare quick tunnel URLs can change after restart.
- Use `openapi.agentbridge.gpt-actions.json` if GPT Builder rejects the canonical schema.

---

## Codex Plugin Setup

The local Codex plugin lives in:

```text
plugins/codexlink/
```

Setup flow:

1. Enable the repo-local marketplace in Codex.
2. Enable the CodexLink plugin.
3. Review and trust the `SessionStart` hook once.
4. Open a new Codex chat.

The hook bootstraps the shared session and lets Codex use `session_context` / `session_timeline` to resume context without long pasted prompts.

Detailed setup:

```text
docs/guides/CODEXLINK_PLUGIN_SETUP.md
```

Dry-run:

```powershell
node plugins/codexlink/hooks/session_start.mjs --dry-run
```

Diagnostics:

```powershell
node dist\cli.js setup codex-plugin --dry-run
node dist\cli.js doctor
node dist\cli.js doctor --json
```

---

## MCP Tools

MCP remains STDIO-only. CodexLink does not expose an HTTP `/mcp` endpoint.

Important shared session MCP tools include:

- `session_bootstrap`
- `session_summary`
- `session_updates`
- `session_activity`
- `session_timeline`
- `session_context`
- `session_reconcile`
- `session_append_event`
- `session_add_handoff`
- `session_update_handoff`
- `session_set_goal`
- `session_append_check`

---

## Safety Model

CodexLink is local-first and allowlist-based.

Blocked or avoided by design:

- `.env` and `.env.*`
- `.agentbridge/local_token`
- private keys such as `.pem`, `.key`, `id_rsa`, `id_ed25519`
- binary files
- path traversal such as `../secret`
- raw absolute file paths as project IDs
- raw file content in session memory
- long raw terminal output in session memory
- raw diffs in session memory
- token-like values, which are redacted
- HTTP `/mcp`
- arbitrary command runner
- OpenAI API key requirement

Large safe text files are bounded and returned with truncation metadata instead of unlimited reads.

---

## Current Status

| Milestone | Status |
|---|---|
| v0.4 Direct GPT Action handshake | Passed |
| v0.5 Project registry / safe reader | Passed |
| v0.6 Shared session workspace memory | Passed |
| v0.7 Codex plugin auto session | Passed |
| v1.0 Activity Trace & Workspace Timeline | Passed |
| v1.1 One-Click Launcher | Local implemented |
| v1.2 Zero-Setup Stable Relay | Planned/design |
| v1.3 Safe Local Edit / Patch Proposal | Planned |
| Docker packaging | Planned |

---

## Development Checks

```powershell
npm run generate:openapi
npm run build
npm test
git diff --check
```

Smoke tests:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\smoke-v08-activity-core.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\smoke-v08-session-activity.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\smoke-v08-workspace-timeline.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\smoke-v08-final-timeline.ps1
```

---

## Docker

Docker packaging is not included in `v1.0.0`. Dockerfile/container deployment will be handled in a later version.

---

## Documentation

Additional docs live under `docs/`:

- `docs/guides/` for plugin, bridge, tunnel, and activity workflows.
- `docs/architecture/` for inspector and registry design notes.
- `docs/specs/` for MCP, safety, and protocol specs.
- `docs/gpt/` for GPT Actions setup and instructions.
- `docs/acceptance/` for milestone acceptance records.

---

## Notes

- CodexLink does not require an OpenAI API key.
- GPT Actions use your local CodexLink bearer token, not an OpenAI API key.
- Runtime `.agentbridge` files are local-only and must not be committed.
- Stable tunnel/domain setup is separate from the local v1.0.0 release.
