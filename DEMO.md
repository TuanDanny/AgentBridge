# AgentBridge v0.4 Project Inspector Demo

This demo shows the Level 3 Project Inspector flow on Windows PowerShell using the local AgentBridge daemon, a user-managed HTTPS tunnel, and the token-protected `/chatgpt/projects*` endpoints.

Do not paste or commit `.agentbridge/local_token`. The demo script reads it locally only to send the bearer auth header and does not print the token value.

## Prerequisites

Build once before the demo if `dist\cli.js` does not exist:

```powershell
npm run build
```

Install `cloudflared` if you want to use the Cloudflare quick tunnel script.

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

The successful path assumes the daemon is serving the `D:\AgentBridge` project with project ID `AgentBridge`. If you have registered multiple projects globally and the ID differs, first inspect `GET /chatgpt/projects` and use the returned safe project ID for manual calls.

## Security Notes

```text
- No OpenAI API key is used.
- No Codex API key is used.
- No token value is printed by the scripts.
- Do not commit .agentbridge/local_token.
- Do not share the bearer token.
- /chatgpt/projects* remains token-protected.
- This is not Streamable HTTP MCP and does not add /mcp.
```

If direct HTTP tool use is unavailable, use the local fallback:

```powershell
node dist\cli.js inspect --for-chatgpt
```
