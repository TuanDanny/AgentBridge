# AgentBridge Group Chat Companion Acceptance

Verification date: 2026-06-01

## Automated Checks

```text
npm run build: pass
npm test: pass
```

Vitest result:

```text
Test Files: 9 passed
Tests: 31 passed
```

## Manual Checks

Manual CLI verification ran against a temporary project directory.

```text
node dist\cli.js capture --mode short
node dist\cli.js group brief
node dist\cli.js group handoff
node dist\cli.js group decision-template
node dist\cli.js group apply-decision
node dist\cli.js group status
```

Result:

```json
{
  "brief_created": true,
  "brief_has_project": true,
  "brief_has_branch": true,
  "brief_has_session_status": true,
  "brief_redacted": true,
  "handoff_created": true,
  "apply_updated_plan": true,
  "apply_regenerated_prompt": true,
  "apply_redacted_secret": true,
  "audit_has_group_apply_decision": true,
  "status_reports_files": true
}
```

## Acceptance Checklist

```text
[x] npm run build pass
[x] npm test pass
[x] agentbridge group brief creates .agentbridge/group_brief.md
[x] group_brief.md has project name, branch, and session status
[x] group_brief.md has no token or secret
[x] agentbridge group handoff creates .agentbridge/group_handoff.md
[x] agentbridge group decision-template creates .agentbridge/group_decision.md
[x] apply-decision updates chatgpt_plan.md
[x] apply-decision regenerates codex_prompt.md
[x] audit.jsonl has group.apply_decision
[x] docs explain group chat is only a coordination layer
[x] STDIO MCP tests still pass
[x] HTTP /chatgpt/* tests still pass
```

## Notes

Group Chat Companion Mode is a copy/paste coordination workflow. AgentBridge remains the source of truth.
