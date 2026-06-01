# AgentBridge ChatGPT Tool Adapter

## Status

v0.4-gamma adds an OpenAPI adapter spec for compatible HTTP tool/action clients:

```text
openapi.agentbridge.json
```

This is not Streamable HTTP MCP. AgentBridge still does not expose or claim a working `/mcp` HTTP endpoint.

## Purpose

The adapter describes the Project Inspector HTTP endpoints added in v0.4-beta:

```text
GET /chatgpt/projects
GET /chatgpt/projects/:projectId/inspect
GET /chatgpt/projects/:projectId/codex-changes
GET /chatgpt/projects/:projectId/review-packet
```

A compatible HTTP tool, action, or client can import `openapi.agentbridge.json`, replace the server URL placeholder with a real HTTPS tunnel URL, and call the endpoints with bearer token auth.

## Start AgentBridge

Start the local daemon on loopback:

```bash
agentbridge start --host 127.0.0.1 --port 7777
```

Keep the daemon bound to `127.0.0.1` unless you have a specific local networking reason to change it.

## Start A Tunnel

Use a user-managed HTTPS tunnel to forward the local daemon.

Cloudflare quick tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:7777
```

ngrok:

```bash
ngrok http 7777
```

Quick tunnel URLs are temporary. Register the current public URL after the tunnel is running.

## Register The Tunnel

Register the public HTTPS URL with AgentBridge:

```bash
agentbridge tunnel register https://YOUR-TUNNEL-URL.example
```

Then verify it:

```bash
agentbridge tunnel test
```

`agentbridge tunnel register` stores only tunnel metadata in `.agentbridge/remote_bridge.json`. It does not store the bearer token there.

## Bearer Token Security

The OpenAPI spec uses this security scheme:

```text
Authorization: Bearer <your local AgentBridge token>
```

Handle the token as a local secret:

```text
- Do not paste the token into openapi.agentbridge.json.
- Do not commit .agentbridge/local_token.
- Do not share the token in group chats, tickets, docs, screenshots, logs, or PRs.
- Rotate the token by deleting .agentbridge/local_token and restarting AgentBridge if it leaks.
```

The adapter does not require `OPENAI_API_KEY`, `CODEX_API_KEY`, or any other API key.

## Import The OpenAPI Spec

Use:

```text
openapi.agentbridge.json
```

Before importing it into a compatible client, replace:

```text
https://YOUR-TUNNEL-URL.example
```

with your registered HTTPS tunnel URL.

The spec defines these operation IDs:

```text
listProjects
inspectProject
getCodexChanges
getReviewPacket
```

The client should first call `listProjects`, then pass a returned `projectId` into the project-specific operations. Raw filesystem paths are not accepted by the HTTP endpoints.

## ChatGPT Direct Use

ChatGPT direct use depends on whether the current ChatGPT client, action system, connector, or compatible tool runner can:

```text
- import an OpenAPI schema
- reach the HTTPS tunnel URL
- attach the bearer token securely
- send requests to the Project Inspector endpoints
```

This repository does not add cloud/team/account mode. It only provides a local-first HTTP adapter spec for clients that already support this style of tool/action integration.

## Fallback

If direct HTTP tool use is unavailable, use the local packet workflow:

```bash
agentbridge inspect --for-chatgpt
```

Review the generated file locally before sharing it:

```text
.agentbridge/project_inspect_packet.md
```

The packet is redacted and truncated by AgentBridge, but you should still inspect it before pasting it anywhere.

## Not MCP

`/chatgpt/*` is a custom JSON bridge. It is not MCP protocol.

Streamable HTTP MCP remains deferred until AgentBridge implements a real MCP SDK transport with protocol-level tests. Do not treat `openapi.agentbridge.json` as an MCP schema.
