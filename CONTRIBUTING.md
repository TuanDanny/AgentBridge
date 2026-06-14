# Contributing

Thanks for improving CodexLink. Keep changes local-first, explicit, and safe.

## Development Setup

```powershell
npm install
npm run build
npm test
```

Useful verification:

```powershell
npm run generate:openapi
git diff --check
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\smoke-v12-hosted-relay-e2e.ps1
```

## Safety Constraints

- Do not add HTTP `/mcp`.
- Do not add arbitrary shell or command runner routes.
- Do not add write/edit/delete file routes without a separate security design.
- Do not require an OpenAI API key.
- Do not commit `.agentbridge/`, `.env`, local tokens, private keys, or generated runtime logs.
- Keep GPT Actions and relay schemas compatible with GPT Builder.

## Pull Request Checklist

- `npm run generate:openapi`
- `npm run build`
- `npm test`
- `git diff --check`
- Relevant smoke script when touching launcher, relay, or session memory.
- No secrets or runtime files added.
