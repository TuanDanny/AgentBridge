# CodexLink One-Click Launcher

The one-click launcher is a local-first daily startup flow for CodexLink. It starts the local AgentBridge server, verifies health, bootstraps the shared session, copies a GPT greeting prompt, and opens your configured GPT URL when one is configured.

It does not read or print `.agentbridge/local_token`, does not require an OpenAI API key, and does not store raw file content, raw diffs, or long terminal output.

## First-Time Setup

For a new machine or fresh clone, double-click:

```text
setup-codexlink-first-time.bat
```

The first-time setup script checks Node/npm, optionally pulls the latest `main`, installs dependencies, builds `dist/`, registers the current repo as a project, creates local launcher config, and can start CodexLink.

For automation or a no-prompt setup check:

```powershell
.\setup-codexlink-first-time.bat --defaults --no-start
```

`--defaults` uses safe defaults: no git pull, the default project ID, no GPT URL, no public URL, and no quick tunnel. `--no-start` prevents launching the daily runner after setup.

Manual equivalent:

```powershell
npm install
npm run build
node dist\cli.js project register-current AgentBridge
```

Daily use after setup:

```text
start-codexlink.bat
```

On first run, the launcher creates a local default config:

```text
.agentbridge/launcher-config.json
```

That file is local runtime state and must not be committed.

For a configured GPT URL and stable GPT Actions endpoint, run:

```powershell
node dist\cli.js setup launcher `
  --project AgentBridge `
  --public-url https://codexlink.example.com `
  --gpt-url https://chatgpt.com/g/YOUR-GPT
```

## Daily Usage

Double click:

```text
start-codexlink.bat
```

The launcher will:

- check Node.js and npm
- ask you to run `npm install` if `node_modules` is missing
- build with `npm run build` if `dist/cli.js` is missing
- create local launcher config on first run if missing
- start `node dist\cli.js start --host 127.0.0.1 --port 7777`
- wait for `/health`
- write `.agentbridge/logs/launcher-YYYYMMDD-HHMMSS.log`
- write `.agentbridge/launcher-state.json`
- bootstrap shared session/context
- copy a GPT greeting prompt if enabled
- open the configured GPT URL if enabled

Paste the copied greeting into GPTs. The launcher does not type into ChatGPT web.

## Greeting Prompt

```text
Xin chào CodexLink.

Hãy gọi listProjects, chọn project mặc định nếu có, rồi gọi getSessionSummary hoặc getSessionContext cho project đó.

Sau đó cho tôi biết:
- project đang active
- session_id/revision
- current_goal
- phase/status
- recent_activity
- workspace snapshot/gaps nếu có
- recommended_next_action

Không đọc repo nếu chưa cần.
```

## What Is Still Needed For GPT Actions

The local launcher can make the local side ready. GPT Actions still need a stable HTTPS endpoint.

Current choices:

- Stable Cloudflare Named Tunnel or another stable domain: recommended practical path.
- Ngrok static domain: useful if it fits your account/plan.
- Cloudflare Quick Tunnel: good for testing, but the URL changes.
- Future CodexLink Relay: planned v1.2 work to reduce tunnel/domain setup.

If no public URL is configured, the launcher will still start local CodexLink and copy the greeting, but GPT Actions cannot call your local machine directly.

Hosted relay mode:

```powershell
node dist\cli.js relay spec
node dist\cli.js setup launcher --project AgentBridge --tunnel-mode relay --relay-url https://relay.codexlink.example.com
start-codexlink.bat
```

When relay mode is configured with `relayUrl`, the launcher starts local AgentBridge, creates a short-lived pairing code, starts the outbound hosted relay client, prints/copies the pairing code once, and adds relay instructions to the copied GPT greeting. The raw pairing code is not written to the launcher log.

Deploy the hosted relay MVP behind HTTPS/WSS:

```powershell
node dist\cli.js relay hosted serve --host 0.0.0.0 --port 8788 --public-url https://relay.codexlink.example.com
```

Use `openapi.codexlink.relay.gpt-actions.json` only with a trusted relay origin.

Local loopback relay prototype is still available for testing:

```powershell
node dist\cli.js relay serve --experimental --host 127.0.0.1 --port 8787
```

`relayHost` for the prototype is intentionally restricted to loopback hosts (`127.0.0.1`, `localhost`, or `::1`) so it is not accidentally exposed.

## Stable Endpoint Recommended

Use a stable HTTPS URL or stable tunnel/domain for GPT Actions. Cloudflare quick tunnel URLs such as `*.trycloudflare.com` are temporary; GPT Actions may need schema updates when the URL changes.

For stable GPT Actions schema generation:

```powershell
node dist\cli.js setup gpt-actions --public-url https://codexlink.example.com
```

## Stop

Double click:

```text
stop-codexlink.bat
```

Or run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop-codexlink.ps1
```

## Troubleshooting

Node missing:

- Install Node.js 18 or newer.

`node_modules` missing:

- Run `npm install`.
- The launcher will not auto-install dependencies unless you explicitly use `-Install`.

Port busy or local health fails:

- Run `node dist\cli.js stop`.
- Check whether another service is using port `7777`.

Public health fails:

- Check your tunnel/domain forwards to `http://127.0.0.1:7777`.
- Run `node dist\cli.js doctor --launcher`.

GPT Actions URL mismatch:

- Regenerate the live schema with `setup gpt-actions --public-url`.
- Re-import or update the GPT Actions schema in GPT Builder.

Quick tunnel warning:

- Quick tunnels are useful for development only.
- Use a stable domain for daily one-click GPTs usage.

## Security Model

- No token is printed by the launcher.
- `.agentbridge/local_token` is not read or displayed.
- Local runtime files stay under `.agentbridge/`.
- No OpenAI API key is required.
- No HTTP `/mcp` endpoint is added.
- No arbitrary command runner is added.
- No raw file content, raw diffs, or long terminal output are stored.
