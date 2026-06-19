# CodexLink Stable Relay on Render

This guide deploys the read-only hosted relay as an always-on Render Docker web service. Render supplies a stable `https://*.onrender.com` origin and terminates HTTPS/WSS. Local AgentBridge and all project files remain on the user's Windows machine.

## Safety Boundary

- GPT visibility: **Only me**.
- No OpenAI API key, local bearer token, `.env`, private key, shell, write-file, or HTTP `/mcp` capability.
- The Render service mounts no workspace directories and stores pairing/session state only in memory.
- All project access is revalidated against the explicit local registry.
- A Render deploy or restart requires pairing again, but the GPT Actions schema URL does not change.

## 1. Prepare GitHub Projects

On the Windows machine, explicitly register every project that may be exposed:

```powershell
cd D:\AgentBridge
node dist\cli.js project register AgentBridge D:\AgentBridge
node dist\cli.js project register MyProject D:\Projects\MyProject
node dist\cli.js project list
```

Remove a project from the relay allowlist by removing it from the registry:

```powershell
node dist\cli.js project remove MyProject
```

Review this list carefully before enabling `--relay-all-registered`. Bulk relay mode includes only `manual` and `current` entries; auto-scanned entries are excluded. Remove sensitive configuration roots such as a user profile or `.codex` directory unless you intentionally want their safe, bounded metadata exposed.

## 2. Deploy the Render Blueprint

1. Sign in to Render and connect the GitHub repository containing AgentBridge.
2. Create a new **Blueprint** and select `render.yaml` from the `main` branch.
3. Keep region **Singapore** and choose the paid always-on web service plan.
4. Approve the service creation. Do not add API keys or local AgentBridge tokens.
5. Wait for `/relay/health` to become healthy.

Record the stable Render origin, for example:

```text
https://codexlink-relay.onrender.com
```

Verify:

```powershell
$RelayUrl="https://YOUR-SERVICE.onrender.com"
Invoke-RestMethod "$RelayUrl/relay/health"
Invoke-RestMethod "$RelayUrl/relay/openapi.json"
```

Expected health metadata includes `ok=true`, `status=hosted_mvp`, and `schema_ready=true`.

## 3. Configure the Private GPT Once

1. Open GPT Builder and keep visibility set to **Only me**.
2. Add an Action and import from:

```text
https://YOUR-SERVICE.onrender.com/relay/openapi.json
```

3. Select **None** for static authentication. Pairing supplies a short-lived relay session header dynamically.
4. Confirm that `pairDevice`, `listProjects`, session, inspector, tree, safe file read, and grep actions appear.
5. Save the GPT and copy its GPT URL.

The schema import is a one-time setup while the Render service URL remains unchanged.

## 4. Configure the Windows Launcher

```powershell
cd D:\AgentBridge
node dist\cli.js setup launcher `
  --project AgentBridge `
  --tunnel-mode relay `
  --relay-url "https://YOUR-SERVICE.onrender.com" `
  --relay-all-registered `
  --gpt-url "https://chatgpt.com/g/YOUR-GPT" `
  --auto-relay-client `
  --auto-bootstrap `
  --open-browser `
  --copy-greeting

node dist\cli.js doctor --launcher --json
```

Doctor should report that relay health and `/relay/openapi.json` are reachable and use the same stable origin.

## 5. Daily Use

1. Double-click `start-codexlink.bat`.
2. The launcher starts local AgentBridge, bootstraps the active project, connects outbound to Render, and prints one short-lived pairing code.
3. Ask the private GPT to call `pairDevice` with that code and a safe session hint.
4. The GPT keeps the returned `relay_session`, calls `listProjects`, and asks which registered project to inspect.
5. Double-click `stop-codexlink.bat` when finished.

No schema copy, tunnel URL update, or Docker relay process is required on the Windows machine after the Render deployment is active.

## 6. Operational Checks

```powershell
Invoke-RestMethod "https://YOUR-SERVICE.onrender.com/relay/health"
node dist\cli.js doctor --launcher
node dist\cli.js project list
```

Invalid pairing attempts are rate-limited. Pairing codes are short-lived and single-use. Relay sessions expire and are intentionally not persisted across Render restarts.
