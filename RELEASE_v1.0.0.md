# CodexLink v1.0.0 - Activity Trace & Workspace Timeline

CodexLink v1.0.0 is the first stable local workspace memory release.

It upgrades AgentBridge/CodexLink from a project bridge into a local memory layer for GPTs, Codex UI, MCP, CLI, and registered local workspaces. GPTs and Codex can now answer not only "what is the latest result?" but also "what happened during the task?", "which files changed?", "what was verified?", and "are there activity gaps?".

## Highlights

- Activity Trace local memory through `activity.jsonl`.
- `recent_activity` and `activity_counts` in shared session summaries.
- Session timeline by recent activity, handoff, file, or task.
- Compact context resume through `session context`.
- Handoff lifecycle activity, including add/update/acknowledge/done metadata.
- Evidence and check metadata in shared sessions.
- Workspace snapshots from safe Git metadata.
- Changed-files summaries using metadata and diff counts.
- Activity gap detection for changed files without recent activity.
- Safe file verification metadata with SHA-256, bytes, and line count.
- Codex plugin SessionStart bootstrap.
- MCP STDIO tools for session coordination.
- Doctor checks for plugin, session, activity trace, workspace snapshot health, compactness, and runtime content safety.

## Safety

CodexLink v1.0.0 keeps the local-first safety model:

- Does not store raw file content in session memory.
- Does not store raw terminal output.
- Does not store raw diff text.
- Does not store full chat transcripts or chain-of-thought.
- Redacts token-like values.
- Blocks `.env`, `.agentbridge/local_token`, private keys, binary files, traversal paths, and unsafe absolute paths.
- Does not add an HTTP `/mcp` endpoint.
- Does not add an arbitrary command runner.
- Does not require an OpenAI API key.
- Runtime `.agentbridge` files remain local-only and must not be committed.

## Verification

Validated before release:

- `npm run generate:openapi`: PASS
- `npm run build`: PASS
- `npm test`: PASS, 19 files / 123 tests
- `git diff --check`: PASS
- `smoke-v08-activity-core.ps1`: PASS, 7 / 0
- `smoke-v08-session-activity.ps1`: PASS, 12 / 0
- `smoke-v08-workspace-timeline.ps1`: PASS, 7 / 0
- `smoke-v08-final-timeline.ps1`: PASS, 13 / 0
- Final v0.8 acceptance stress: PASS, 50 rounds, 0 fail

## Known Limitations

- CodexLink does not store full Codex chat transcripts.
- CodexLink does not store chain-of-thought.
- Direct Codex UI file edits are detected by `session reconcile`, not always in real time.
- Cloudflare quick tunnel URLs can expire or change after restart.
- Stable public URL/tunnel setup remains operational work for a later release.
- Safe Local Edit / Patch Proposal is planned for v1.1.

## Docker Not Included

Docker packaging is not included in v1.0.0.

A Dockerfile, container deployment workflow, and volume/runtime design will be handled in a later version.
