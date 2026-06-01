# AgentBridge Safety Rules

## Phase 1 Guarantees

- AgentBridge does not require API keys.
- AgentBridge does not call remote AI APIs.
- AgentBridge does not run destructive shell commands.
- AgentBridge does not commit, push, force push, or rewrite git history.
- AgentBridge redacts token-like values from generated context.
- AgentBridge logs CLI actions to `.agentbridge/audit.jsonl`.
- AgentBridge binds its daemon to `127.0.0.1` by default.
- AgentBridge requires the local token for daemon data endpoints.

## Secret Redaction

Generated context must redact:

- `.env` values and environment variable assignments containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PRIVATE`, `CLIENT_SECRET`, `AUTH`, or `JWT`.
- Private key blocks.
- Bearer tokens.
- GitHub tokens.
- OpenAI-style `sk-...` tokens.

The redaction replacement is:

```text
[REDACTED]
```

## Risky Commands For Future Approval

AgentBridge classifies these commands as high risk, and blocked where noted:

```text
rm -rf                  blocked
git push --force
git reset --hard
git clean -fd
cat .env
cat id_rsa
chmod -R 777
format disk             blocked
```

Medium-risk commands include `git push`, delete commands, network commands, package publish commands, and permission changes. Medium and high risk commands require approval before any future automation runner may execute them.

## User-Written Files

AgentBridge should not overwrite user-authored planning files by default:

- `.agentbridge/user_intent.md`
- `.agentbridge/chatgpt_plan.md`
- `.agentbridge/codex_result.md`

Generated files may be replaced by their commands:

- `.agentbridge/project_context.md`
- `.agentbridge/codex_prompt.md`
- `.agentbridge/chatgpt_review.md`

## Local Daemon Token

The daemon creates `.agentbridge/local_token` during `agentbridge start`. This token is local-only session state and should not be committed or copied into prompts.

## Approval Queue

Approval items are stored in `.agentbridge/approvals.json` with one of these states:

```text
pending
approved
rejected
expired
```

Every create or state transition is also appended to `.agentbridge/approval_queue.jsonl`.
