# AgentBridge Secure Tunnel Bridge

## Status

v0.3-beta local-first secure tunnel workflow.

## Purpose

Secure Tunnel Bridge helps expose the existing local AgentBridge HTTP bridge through a user-managed HTTPS tunnel such as `cloudflared` or `ngrok`.

This is not cloud mode, team mode, account mode, or hosted AgentBridge. AgentBridge still runs locally, and the tunnel is started manually by the user.

## What This Adds

```text
agentbridge tunnel guide
agentbridge tunnel register <public-url>
agentbridge tunnel status
agentbridge tunnel test
```

Runtime file:

```text
.agentbridge/remote_bridge.json
```

`remote_bridge.json` stores the public URL, local URL, creation time, and a security note. It must not contain `.agentbridge/local_token`.

## Workflow

Start the local daemon:

```bash
agentbridge start --host 127.0.0.1 --port 7777
```

Start a tunnel manually:

```bash
cloudflared tunnel --url http://127.0.0.1:7777
```

or:

```bash
ngrok http 7777
```

Register the HTTPS URL printed by the tunnel tool:

```bash
agentbridge tunnel register https://your-url.example
```

Check status:

```bash
agentbridge tunnel status
```

Run the endpoint checks:

```bash
agentbridge tunnel test
```

## Register Behavior

By default, `agentbridge tunnel register` only accepts `https://` URLs.

For local tests only, `http://` can be accepted with:

```bash
agentbridge tunnel register http://127.0.0.1:7777 --allow-insecure
```

Do not use `--allow-insecure` for an internet tunnel.

## Tunnel Test Checklist

`agentbridge tunnel test` verifies:

```text
GET  <public-url>/health
GET  <public-url>/chatgpt/session-summary without token -> 401
GET  <public-url>/chatgpt/session-summary with token -> ok true
GET  <public-url>/chatgpt/repo-status with token -> ok true
POST <public-url>/chatgpt/classify-command rm -rf node_modules -> risk high, blocked true
```

## Security

Do not share `.agentbridge/local_token`.

Do not commit:

```text
.agentbridge/local_token
.agentbridge/remote_bridge.json
.env
```

Do not paste the token into:

```text
group chat
issue trackers
documentation
logs
screenshots
```

`/chatgpt/*` endpoints remain token-protected. `/health` remains public and only returns liveness metadata.

Anyone with both the public tunnel URL and the local token can access protected AgentBridge endpoints. Treat them as secrets.

## ChatGPT Web Limitation

This workflow only prepares a secure URL for the local HTTP bridge. ChatGPT web direct integration still depends on whether the client, connector, browser helper, or tool can call that URL.

No OpenAI API key is required.
