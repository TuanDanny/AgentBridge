# AgentBridge ChatGPT Tool Adapter

## Status

v0.5-delta updates the OpenAPI adapter specs for compatible HTTP tool/action clients:

```text
openapi.agentbridge.json
openapi.agentbridge.gpt-actions.json
```

This is not Streamable HTTP MCP. AgentBridge still does not expose or claim a working `/mcp` HTTP endpoint.

## Purpose

The adapter describes the Project Inspector and safe project browser HTTP endpoints:

```text
GET /chatgpt/projects
GET /chatgpt/active-project
GET /chatgpt/projects/:projectId/inspect
GET /chatgpt/projects/:projectId/codex-changes
GET /chatgpt/projects/:projectId/review-packet
GET /chatgpt/projects/:projectId/tree
GET /chatgpt/projects/:projectId/files/search
GET /chatgpt/projects/:projectId/file
GET /chatgpt/projects/:projectId/grep
POST /chatgpt/projects/:projectId/select
```

A compatible HTTP tool, action, or client can import an AgentBridge OpenAPI schema, replace the server URL placeholder with a real HTTPS tunnel URL, and call the endpoints with bearer token auth.

After v0.5 registry setup, `listProjects` can return multiple registered local projects. A GPT should call `listProjects` first, show a project picker, call `selectProject` after the user chooses, and then inspect or browse only the selected project.

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

For ChatGPT GPT Actions, use:

```text
openapi.agentbridge.gpt-actions.json
```

This schema inlines every operation parameter because GPT Actions may reject `$ref` entries inside `parameters`.

For other OpenAPI-compatible clients that accept parameter references, the canonical schema remains:

```text
openapi.agentbridge.json
```

Before importing either schema into a compatible client, replace:

```text
https://YOUR-TUNNEL-URL.example
```

with your registered HTTPS tunnel URL.

In GPT Actions, configure authentication as bearer token auth and provide the local AgentBridge token through the GPT Actions authentication UI. Do not paste the token into the schema file.

The spec defines these operation IDs:

```text
listProjects
inspectProject
getCodexChanges
getReviewPacket
getProjectTree
searchProjectFiles
readProjectFile
searchProjectText
selectProject
getActiveProject
```

The client should first call `listProjects`, then pass a returned `projectId` into the project-specific operations. Raw filesystem paths are not accepted by the HTTP endpoints. File reads use project-relative paths only; absolute paths, traversal, sensitive files, binary files, and oversized reads are rejected or limited.

Suggested GPT starter:

```text
Start CodexLink and show my available projects.
```

Suggested GPT behavior:

```text
1. Call listProjects first.
2. Show a table with project id, branch, status, registration state, and root hint.
3. Ask the user to choose by number or projectId.
4. Call selectProject for the chosen project.
5. Inspect, browse, search, or read only the selected project.
6. Do not inspect every project by default.
```

## ChatGPT Direct Use

ChatGPT direct use depends on whether the current ChatGPT client, action system, connector, or compatible tool runner can:

```text
- import an OpenAPI schema
- reach the HTTPS tunnel URL
- attach the bearer token securely
- send requests to the Project Inspector and safe browser endpoints
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

Streamable HTTP MCP remains deferred until AgentBridge implements a real MCP SDK transport with protocol-level tests. Do not treat either OpenAPI schema as an MCP schema.

There is no HTTP scan endpoint. Safe project discovery remains CLI-only.
