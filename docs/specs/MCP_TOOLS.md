# AgentBridge MCP Tools Contract

This document defines the intended MCP tool contract for future phases. Phase 0+1 only creates the file-based protocol that these tools will later read and write.

## ChatGPT Tools

### agentbridge.get_project_context

Returns a short, redacted project context assembled from `.agentbridge/project_context.md`, git status, and session state.

Input:

```json
{
  "mode": "short"
}
```

Output:

```json
{
  "context": "markdown",
  "redacted": true,
  "session_id": "string"
}
```

### agentbridge.get_session_summary

Returns the current user goal, task status, branch, test status, and next action.

### agentbridge.create_codex_prompt

Accepts a ChatGPT plan and writes a Codex-ready prompt into the shared session.

### agentbridge.review_codex_result

Returns the review packet for ChatGPT after Codex has submitted a result.

### agentbridge.get_next_action

Returns the next recommended user, ChatGPT, Codex, or AgentBridge action.

## Codex Tools

### agentbridge.get_user_intent

Returns `.agentbridge/user_intent.md`.

### agentbridge.get_chatgpt_plan

Returns `.agentbridge/chatgpt_plan.md`.

### agentbridge.get_next_task

Returns the current Codex task from `.agentbridge/codex_prompt.md`.

### agentbridge.report_progress

Appends a progress update to `.agentbridge/codex_progress.md` and audit log.

### agentbridge.submit_result

Writes or updates `.agentbridge/codex_result.md`.

### agentbridge.request_user_approval

Creates a future approval item for risky commands or file operations.

## Minimum Future Tool Set

The first real MCP server should expose only these tools:

- `get_project_context`
- `get_session_summary`
- `create_codex_prompt`
- `get_next_task`
- `report_progress`
- `submit_codex_result`
- `review_codex_result`

The current implementation also exposes:

- `request_user_approval`
- `get_repo_status`
- `classify_command`
- `session_bootstrap`
- `session_summary`
- `session_updates`
- `session_activity`
- `session_append_event`
- `session_add_handoff`
- `session_update_handoff`
- `session_set_goal`
- `session_append_check`
