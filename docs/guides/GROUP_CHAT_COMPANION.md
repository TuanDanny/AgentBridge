# AgentBridge Group Chat Companion

## Status

v0.3-alpha local group-chat coordination workflow.

## Purpose

Group Chat Companion Mode creates safe, redacted Markdown packets that a user can copy into a ChatGPT group chat, then import the group decision back into AgentBridge.

The group chat is only a coordination layer. AgentBridge remains the source of truth for session state, plans, prompts, review packets, approvals, and safety history.

## What This Adds

```text
agentbridge group brief
agentbridge group handoff
agentbridge group decision-template
agentbridge group apply-decision
agentbridge group status
```

Generated local files:

```text
.agentbridge/group_brief.md
.agentbridge/group_handoff.md
.agentbridge/group_decision.md
```

## Workflow

Create a group brief:

```bash
agentbridge group brief
```

Copy `.agentbridge/group_brief.md` into ChatGPT group chat.

When Codex has produced a result and the group needs to review it:

```bash
agentbridge group handoff
```

Create a decision template:

```bash
agentbridge group decision-template
```

Paste the group decision into `.agentbridge/group_decision.md`, then apply it:

```bash
agentbridge group apply-decision
```

AgentBridge will:

```text
1. Read .agentbridge/group_decision.md.
2. Redact secret-like values.
3. Update .agentbridge/chatgpt_plan.md.
4. Update .agentbridge/next_action.md.
5. Update .agentbridge/session.json.
6. Regenerate .agentbridge/codex_prompt.md.
7. Append group.apply_decision to .agentbridge/audit.jsonl.
```

`apply-decision` does not run Codex. It only prepares the next task.

Check group companion state:

```bash
agentbridge group status
```

## Safety

Do not paste tokens or secrets into group chat.

AgentBridge redacts secret-like values from generated group files and from decisions applied back into the plan. This includes API keys, tokens, passwords, private keys, bearer tokens, and similar assignment patterns.

The group workflow never reads or prints `.agentbridge/local_token`.

Do not use group chat as durable project memory. Use AgentBridge files and audit history as the source of truth.

## What This Does Not Do

```text
- It does not use OpenAI API keys.
- It does not control ChatGPT UI automatically.
- It does not replace the accepted STDIO MCP flow.
- It does not replace the /chatgpt/* HTTP bridge.
- It does not run destructive commands.
- It does not implement cloud/team mode.
```

## Manual Checks

```powershell
npm run build
npm test
node dist\cli.js group brief
node dist\cli.js group handoff
node dist\cli.js group decision-template
node dist\cli.js group status
```

After editing `.agentbridge/group_decision.md`:

```powershell
node dist\cli.js group apply-decision
```

Expected result:

```text
.agentbridge/chatgpt_plan.md updated
.agentbridge/next_action.md updated
.agentbridge/codex_prompt.md regenerated
.agentbridge/audit.jsonl contains group.apply_decision
```
