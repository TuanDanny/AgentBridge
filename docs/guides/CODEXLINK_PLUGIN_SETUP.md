# CodexLink Local Plugin Setup

CodexLink v0.7-beta adds a repo-local Codex plugin that bundles:

- AgentBridge STDIO MCP config.
- Codex shared-session skill instructions.
- A `SessionStart` hook that calls `session bootstrap`.
- A local marketplace entry.

## Enable

1. Build AgentBridge:

   ```powershell
   npm run build
   ```

2. Confirm the local marketplace exists:

   ```text
   .agents/plugins/marketplace.json
   ```

3. Restart Codex or reload plugins so Codex sees `codexlink`.
4. Enable the CodexLink plugin.
5. Review and trust the `SessionStart` hook once.

Hooks are not trusted automatically. Codex must show the hook for review before it runs.

## Verify

Run the hook in dry-run mode:

```powershell
node plugins/codexlink/hooks/session_start.mjs --dry-run
```

Expected output:

```text
CodexLink dry run: project=<projectId> action=session_bootstrap
```

Verify MCP tools after Codex reloads the plugin:

```text
session_bootstrap
session_summary
session_append_event
session_add_handoff
session_update_handoff
session_set_goal
```

If `session_bootstrap` is missing but older session tools are present, the MCP server is stale. Restart Codex or reload plugins so the stdio server starts from the current `dist`.

## Root Resolution

The plugin avoids hardcoded local paths. It resolves AgentBridge root in this order:

1. `AGENTBRIDGE_ROOT`
2. `CODEXLINK_AGENTBRIDGE_ROOT`
3. repo-relative path when the plugin is inside this repo
4. parent search for a built AgentBridge package

If the plugin is copied outside the repo, set `AGENTBRIDGE_ROOT` to the AgentBridge checkout before enabling MCP/hook.

## Project Resolution

The hook resolves project ID in this order:

1. `--project-id`
2. `CODEXLINK_PROJECT_ID`
3. `AGENTBRIDGE_PROJECT_ID`
4. `.agentbridge/project.json`
5. project registry match by root
6. active project
7. current folder basename fallback

## Safety

- The plugin does not use OpenAI API keys.
- The hook does not read or print `.agentbridge/local_token`.
- The hook does not print bearer tokens.
- The hook stores session metadata only, not raw file content.
- MCP remains STDIO-only; there is no HTTP `/mcp` endpoint.
- The hook does not push, tag, release, npm publish, or run arbitrary commands.

## Disable Or Roll Back

Disable the plugin in Codex, or remove/comment the `codexlink` entry from:

```text
.agents/plugins/marketplace.json
```

Then restart Codex or reload plugins.
