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

Record a workspace snapshot and detect changed files without recent activity:

```powershell
node dist\cli.js session reconcile AgentAI --json
```

Verify a safe text file without storing its content:

```powershell
node dist\cli.js session file-verify AgentAI --path reports/summary.md --expect-sha256 <sha256>
```

`session reconcile` records metadata-only activity such as:

- `workspace_snapshot`
- `changed_files_summary`
- `activity_gap_detected`

`session file-verify` records:

- `file_verify`
- path
- byte count
- line count
- SHA-256 hash
- expected/actual match status
- `content_stored=false`

## MCP

Codex can read activity through:

```text
session_activity
```

Codex can also run workspace reconcile through:

```text
session_reconcile
```

The normal `session_summary` response also includes `recent_activity` and `activity_counts`.

## Workspace Safety

Workspace snapshot and reconcile use `git status --short` and `git diff --numstat` metadata. They do not store raw diff text.

File verification is limited to safe text files and blocks:

- `.env` and `.env.*`
- `.agentbridge/local_token`
- private keys such as `*.pem`, `*.key`, `id_rsa`, `id_ed25519`
- binary files
- large files over the verification limit
- traversal or absolute paths
- `node_modules` and `.git`

## Security

Activity must not store:

- raw file content
- raw terminal output
- raw diffs
- `.env` values
- local tokens or bearer tokens
- private keys or API keys

Activity summaries, paths, and metadata are redacted and truncated before storage.
