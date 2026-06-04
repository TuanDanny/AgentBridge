# AgentBridge Project Registry

## Status

v0.5 adds a local Project Registry and Project Picker backend for ChatGPT/GPT Actions.

The registry is an explicit allowlist. v0.5-beta adds CLI-only safe project discovery for a user-selected folder. AgentBridge does not scan the whole machine and does not auto-discover Codex app workspaces in this phase.

## Registry File

The registry lives in the current AgentBridge root:

```text
.agentbridge/projects.json
```

Schema:

```json
{
  "version": 1,
  "projects": [
    {
      "id": "AgentBridge",
      "name": "AgentBridge",
      "root": "D:\\AgentBridge",
      "type": "git",
      "source": "manual",
      "created_at": "2026-06-02T10:00:00.000Z",
      "updated_at": "2026-06-02T10:00:00.000Z",
      "last_seen": "2026-06-02T10:00:00.000Z"
    }
  ]
}
```

`.agentbridge/projects.json` is local-only and ignored by git. It contains local paths and must not contain tokens, API keys, authorization headers, cookies, or private keys.

## Safe Project IDs

Project IDs must match:

```text
^[A-Za-z0-9._-]{1,80}$
```

AgentBridge rejects IDs that look like raw paths or traversal attempts, including `/`, `\`, `:`, `..`, drive letters, URLs, and empty strings.

HTTP clients must use a project ID returned by `listProjects`. They cannot pass raw filesystem paths.

## CLI

Register a project manually:

```powershell
node dist\cli.js project register AgentBridge D:\AgentBridge
node dist\cli.js project register CoreWeaver D:\CoreWeaver
```

Register the current project:

```powershell
cd D:\AgentBridge
node dist\cli.js project register-current
```

Register the current project with an explicit ID:

```powershell
node dist\cli.js project register-current AgentBridge
```

List projects:

```powershell
node dist\cli.js project list
node dist\cli.js project list --json
```

Inspect a registered project:

```powershell
node dist\cli.js project inspect AgentBridge
node dist\cli.js project inspect AgentBridge --json
node dist\cli.js project inspect AgentBridge --changes
```

Remove a registry entry:

```powershell
node dist\cli.js project remove CoreWeaver
```

Remove only deletes the registry entry. It never deletes the project folder.

## Safe Project Discovery

v0.5-beta can scan a specific folder chosen by the user, preview candidate projects, and register selected or all candidates.

This is CLI-only in v0.5-beta:

```text
- No HTTP scan endpoint exists.
- GPT Actions cannot pass arbitrary scan roots.
- CodexLink does not scan the whole machine.
- CodexLink does not auto-read Codex app workspace internals.
- Preview mode does not write .agentbridge/projects.json.
- Register mode writes only the selected/all discovered candidates.
```

Preview candidates:

```powershell
node dist\cli.js project scan D:\Projects --preview
node dist\cli.js project scan D:\Projects --preview --json
```

Register all candidates:

```powershell
node dist\cli.js project scan D:\Projects --register
```

Register selected candidates by 1-based index:

```powershell
node dist\cli.js project scan D:\Projects --register --select 1,3
node dist\cli.js project list
```

Scan limits:

```powershell
node dist\cli.js project scan D:\Projects --preview --max-depth 4 --max-projects 50
```

Candidate projects must contain at least one strong marker such as `.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `build.gradle`, `tsconfig.json`, `vite.config.ts`, `next.config.js`, `angular.json`, `composer.json`, `Gemfile`, `CMakeLists.txt`, or `Makefile`.

The scan never descends into ignored folders such as `node_modules`, `.git`, `.agentbridge`, `dist`, `build`, `out`, `target`, `.venv`, `venv`, `__pycache__`, `.next`, `.turbo`, `.cache`, `.idea`, `.vscode`, `coverage`, `vendor`, `bin`, or `obj`.

Broad/system roots are rejected. Choose a specific projects folder, not `C:\`, `D:\`, `/`, `Windows`, `Program Files`, `System32`, AppData roots, a `Users` root, or the whole home folder.

Scanned registry entries use `source: "scan"`. Registry entries store project metadata and local paths only; they do not store tokens, authorization headers, tunnel URLs, API keys, cookies, or private keys.

## HTTP Project Picker

All `/chatgpt/*` endpoints still require the local bearer token, except `/health`.

List projects:

```text
GET /chatgpt/projects
```

If the registry has entries, the response includes:

```json
{
  "ok": true,
  "mode": "registry",
  "projects": [
    {
      "id": "AgentBridge",
      "name": "AgentBridge",
      "root_hint": "D:\\...\\AgentBridge",
      "registered": true,
      "branch": "main",
      "clean": true,
      "last_seen": "2026-06-02T10:00:00.000Z"
    }
  ]
}
```

If the registry is empty, AgentBridge keeps the v0.4 fallback:

```json
{
  "ok": true,
  "mode": "current_project_fallback",
  "projects": [
    {
      "id": "AgentBridge",
      "name": "AgentBridge",
      "root_hint": "D:\\...\\AgentBridge",
      "registered": false
    }
  ]
}
```

Inspect a selected project:

```text
GET /chatgpt/projects/:projectId/inspect
GET /chatgpt/projects/:projectId/codex-changes
GET /chatgpt/projects/:projectId/review-packet
```

Resolution rules:

```text
- If registry has entries, projectId must match a registered project.
- If registry is empty, only the current fallback project is allowed.
- Unknown project IDs return 404.
- Raw filesystem paths are never accepted.
```

## GPT Project Picker Flow

Recommended GPT behavior:

```text
1. User starts CodexLink.
2. GPT calls listProjects.
3. GPT displays a project picker.
4. User chooses by number or projectId.
5. GPT calls inspectProject for the selected project.
6. GPT does not inspect every project deeply by default.
```

Project picker prompt example:

```text
CodexLink found 2 projects:

| # | Project ID | Branch | Status | Registered | Root hint |
|---|---|---|---|---|---|
| 1 | AgentBridge | main | clean | true | D:\...\AgentBridge |
| 2 | CoreWeaver | main | dirty | true | D:\...\CoreWeaver |

Which project do you want to work with?
```

## Safe Project Tree And File Reader

v0.5-gamma adds read-only project browsing for the selected project.

CLI:

```powershell
node dist\cli.js project tree AgentBridge --json
node dist\cli.js project find-file AgentBridge README --json
node dist\cli.js project read-file AgentBridge README.md --json
node dist\cli.js project grep AgentBridge "search text" --json
```

GPT Actions:

```text
GET /chatgpt/projects/:projectId/tree
GET /chatgpt/projects/:projectId/files/search
GET /chatgpt/projects/:projectId/file
GET /chatgpt/projects/:projectId/grep
```

Safety rules:

```text
- projectId must come from listProjects.
- readProjectFile paths are project-relative only.
- Absolute paths, drive paths, URLs, and traversal are rejected.
- .env, local_token, private key files, sqlite/db files, and binary files are blocked.
- .git, node_modules, dist, build, target, caches, virtualenvs, IDE folders, vendor, bin, and obj are ignored.
- Returned text is redacted and truncated.
- There is no HTTP scan endpoint.
```

## Active Project

v0.5-delta stores a lightweight active project selection:

```powershell
node dist\cli.js project select AgentBridge
node dist\cli.js project active
node dist\cli.js project clear-active
```

GPT Actions:

```text
POST /chatgpt/projects/:projectId/select
GET /chatgpt/active-project
```

Selection writes only `.agentbridge/active_project.json` in the AgentBridge root:

```json
{
  "project_id": "AgentBridge",
  "selected_at": "2026-06-02T09:30:00.000Z",
  "selected_by": "chatgpt_action"
}
```

It does not store root paths, bearer tokens, API keys, or auth headers.

## Not Implemented In v0.5

```text
- Codex app workspace auto-discovery.
- HTTP scan endpoint.
- Level 4 dispatch/write loop.
- Streamable HTTP MCP.
```

Any future scan expansion must remain preview-first and user-confirmed. AgentBridge must not scan the whole machine by default.

## Troubleshooting

`401 Unauthorized`:

```text
- The request is missing the local bearer token.
- Configure GPT Actions bearer auth with .agentbridge/local_token through the Actions UI.
- Do not paste the token into OpenAPI files or docs.
```

`404 project_not_found`:

```text
- Call GET /chatgpt/projects first.
- Use exactly the project id returned by listProjects.
- Register the project with agentbridge project register or agentbridge project register-current.
- Raw filesystem paths are intentionally rejected.
```

Empty registry:

```text
- This is expected before registration.
- AgentBridge returns mode: current_project_fallback.
- Run agentbridge project register-current <id> to make the project explicit.
```

Stale session:

```text
- Each project reads its own .agentbridge session files.
- If a registered project has no .agentbridge/session.json, inspector output falls back to default/missing local state for that root.
- Run agentbridge capture, prompt, result, or review inside that project to refresh local context.
```

Unexpected branch/status:

```text
- Branch and clean/dirty status are read from the registered project root.
- Non-git directories are allowed and report git availability as false.
```
