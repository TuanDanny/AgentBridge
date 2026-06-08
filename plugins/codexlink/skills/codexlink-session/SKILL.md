---
name: codexlink-session
description: Keep Codex synchronized with AgentBridge shared workspace sessions.
---

At the start of work in any CodexLink-enabled project, use the shared session as the source of truth.

Rules:

1. Call `session_bootstrap` first. If the SessionStart hook did not run or the tool is missing because MCP was not reloaded, use the CLI fallback `node dist/cli.js session bootstrap <projectId> --source codex_plugin --json`.
2. Treat `current_goal`, `phase`, `status`, `do_not_do`, `warnings`, `open_handoffs`, `recent_activity`, `recent_events`, `recent_evidence`, and `recent_checks` from the shared session summary as authoritative.
3. Use MCP session tools for normal coordination: `session_summary`, `session_updates`, `session_activity`, `session_append_event`, `session_add_handoff`, `session_update_handoff`, `session_set_goal`, and `session_append_check`.
4. Log activity, evidence, and check metadata only. Do not store raw file content, raw diffs, long terminal output, secrets, tokens, `.env` values, `local_token` values, private keys, or bearer tokens in session events, handoffs, evidence, activity, or checks.
5. Do not push, tag, release, npm publish, or create a GitHub Release unless the user explicitly asks for that operation.
6. Before ending work or handing back to ChatGPT, update the relevant handoff or append a short summary event with what changed, what was verified, and what remains.
7. If an open handoff targets `codex`, acknowledge or complete it through the shared session instead of relying on chat memory.
8. After creating, editing, deleting, or verifying files, record metadata through `session activity-add`, `session file-verify`, or `session reconcile`; prefer `session reconcile <projectId> --json` before task completion so changed files without activity are detected as gaps.
9. Use `session file-verify <projectId> --path <path>` for safe text files when a hash/bytes/line-count proof is useful. Never store raw file content in session metadata.
