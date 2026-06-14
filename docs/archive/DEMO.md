# AgentBridge v0.5 Project Registry Demo

This demo shows the Level 3 Project Inspector and v0.5 Project Registry flow on Windows PowerShell using the local AgentBridge daemon, a user-managed HTTPS tunnel, and the token-protected `/chatgpt/projects*` endpoints.

Do not paste or commit `.agentbridge/local_token`. The demo script reads it locally only to send the bearer auth header and does not print the token value.

## Prerequisites

Build once before the demo if `dist\cli.js` does not exist:

```powershell
npm run build
```

Install `cloudflared` if you want to use the Cloudflare quick tunnel script.

Register the current project so `listProjects` returns a project picker entry with `registered: true`:

```powershell
cd D:\AgentBridge
node dist\cli.js project register-current AgentBridge
node dist\cli.js project list
```

## Terminal 1: Start AgentBridge

```powershell
cd D:\AgentBridge
.\scripts\start-agentbridge.ps1
```

Expected local URL:

```text
http://127.0.0.1:7777
```

Keep this terminal open.

## Terminal 2: Start The Tunnel

```powershell
cd D:\AgentBridge
.\scripts\start-tunnel.ps1
```

Copy the generated public URL:

```text
https://YOUR-TUNNEL-URL.trycloudflare.com
```

Quick tunnel URLs are temporary. Do not put a real tunnel URL in committed docs.

## Terminal 3: Run The Inspector Demo

Replace the placeholder with the URL copied from Terminal 2:

```powershell
cd D:\AgentBridge
.\scripts\demo-inspector.ps1 -TunnelUrl "https://YOUR-TUNNEL-URL.trycloudflare.com"
```

The script runs:

```text
node dist/cli.js tunnel register <TunnelUrl>
node dist/cli.js tunnel test
GET <TunnelUrl>/chatgpt/projects
GET <TunnelUrl>/chatgpt/projects/AgentBridge/inspect
GET <TunnelUrl>/chatgpt/projects/AgentBridge/codex-changes
GET <TunnelUrl>/chatgpt/projects/AgentBridge/review-packet
GET <TunnelUrl>/chatgpt/projects without token, expecting 401
GET <TunnelUrl>/chatgpt/projects/not-exist/inspect, expecting 404
```

The successful path assumes the daemon is serving the `D:\AgentBridge` project with project ID `AgentBridge`. If you registered multiple local projects and the ID differs, first inspect `GET /chatgpt/projects` and use the returned safe project ID for manual calls.

`GET /chatgpt/projects` is the lightweight project picker call. GPTs should show the returned project list and inspect only the project selected by the user.

## v0.5-beta: Safe Project Discovery Demo

Use this when you have several local projects under one folder and do not want to register them one at a time.

Preview candidates first:

```powershell
cd D:\AgentBridge
node dist\cli.js project scan D:\Projects --preview
```

Preview as JSON:

```powershell
node dist\cli.js project scan D:\Projects --preview --json
```

Register selected candidates by index:

```powershell
node dist\cli.js project scan D:\Projects --register --select 1,3
node dist\cli.js project list
```

After the daemon and tunnel are running, GPT Actions calls `GET /chatgpt/projects`. The response should show multiple registered projects with `mode: "registry"`. The user chooses one project ID, then GPT calls the inspector endpoints for that selected project only.

The scan is CLI-only in v0.5-beta. CodexLink does not expose a `/chatgpt/scan` endpoint, does not accept scan roots over HTTP, does not scan the whole machine, and does not auto-read Codex app workspace internals.

## v0.5-gamma/delta: Browse And Select

After registering projects, try the safe local browser:

```powershell
node dist\cli.js project tree AgentBridge --json
node dist\cli.js project find-file AgentBridge README --json
node dist\cli.js project read-file AgentBridge README.md --json
node dist\cli.js project grep AgentBridge "AgentBridge" --json
```

Select the active project:

```powershell
node dist\cli.js project select AgentBridge
node dist\cli.js project active
```

GPT Actions can call:

```text
selectProject
getActiveProject
getProjectTree
searchProjectFiles
readProjectFile
searchProjectText
```

File reads are project-relative and safe-limited. CodexLink rejects traversal, absolute paths, sensitive files, binary files, and oversized content.

## Security Notes

```text
- No OpenAI API key is used.
- No Codex API key is used.
- No token value is printed by the scripts.
- Do not commit .agentbridge/local_token.
- Do not share the bearer token.
- /chatgpt/projects* remains token-protected.
- HTTP project IDs are safe IDs from listProjects, not raw filesystem paths.
- Users explicitly choose which project roots to expose.
- Codex app workspace auto-discovery is not implemented in this demo.
- Safe folder scan is CLI-only and preview-first.
- Safe file browsing is scoped to registered projects.
- This is not Streamable HTTP MCP and does not add /mcp.
```

If direct HTTP tool use is unavailable, use the local fallback:

```powershell
node dist\cli.js inspect --for-chatgpt
```
