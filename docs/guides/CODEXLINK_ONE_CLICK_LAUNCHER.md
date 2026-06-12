# CodexLink One-Click Launcher

The one-click launcher is a local-first daily startup flow for CodexLink. It starts the local AgentBridge server, verifies health, optionally bootstraps the shared session, copies a GPT greeting prompt, and opens your configured GPT URL.

It does not read or print `.agentbridge/local_token`, does not require an OpenAI API key, and does not store raw file content, raw diffs, or long terminal output.

## First-Time Setup

Install dependencies and build once:

```powershell
npm install
npm run build
```

Create local launcher config:

```powershell
node dist\cli.js setup launcher `
  --project AgentBridge `
  --public-url https://codexlink.example.com `
  --gpt-url https://chatgpt.com/g/YOUR-GPT
```

The config is stored in `.agentbridge/launcher-config.json`. It is local runtime state and must not be committed.

## Daily Usage

Double click:

```text
start-codexlink.bat
```

The launcher will:

- check Node.js and npm
- ask you to run `npm install` if `node_modules` is missing
- build with `npm run build` if `dist/cli.js` is missing
- start `node dist\cli.js start --host 127.0.0.1 --port 7777`
- wait for `/health`
- write `.agentbridge/logs/launcher-YYYYMMDD-HHMMSS.log`
- write `.agentbridge/launcher-state.json`
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
- No raw file content, raw diffs, or long terminal output are stored.
