# CodexLink Activity Trace

CodexLink v0.8-alpha adds a local activity timeline for shared sessions. Activity is metadata only: it records what happened, which actor/source performed it, related paths or ids, and revision before/after when available.

## Storage

Activity is stored beside the existing shared session files:

```text
.agentbridge/sessions/<projectId>/<sessionId>/activity.jsonl
```

Runtime `.agentbridge` files remain local-only and must not be committed.

## CLI

Read recent activity:

```powershell
node dist\cli.js session activity AgentAI --json
```

Append metadata-only activity:

```powershell
node dist\cli.js session activity-add AgentAI --kind file_create --status success --summary "Created report stub" --path reports/summary.md
```

## MCP

Codex can read activity through:

```text
session_activity
```

The normal `session_summary` response also includes `recent_activity` and `activity_counts`.

## Security

Activity must not store:

- raw file content
- raw terminal output
- raw diffs
- `.env` values
- local tokens or bearer tokens
- private keys or API keys

Activity summaries, paths, and metadata are redacted and truncated before storage.
