import fs from "node:fs";
import { createCodexPrompt } from "./core.js";
import { pathExists, readTextIfExists, writeText, writeTextIfMissing } from "./fsx.js";
import { getGitInfo } from "./git.js";
import { bridgePath, getBridgeDir, resolveProjectRoot } from "./paths.js";
import { redactSecrets } from "./redact.js";
import { listApprovals } from "./safety.js";
import { appendAudit, ensureProjectScaffold, readSession, updateSession } from "./session.js";
import { generatedNotice } from "./templates.js";
import type { CommandResult } from "./types.js";

const GROUP_BRIEF = "group_brief.md";
const GROUP_HANDOFF = "group_handoff.md";
const GROUP_DECISION = "group_decision.md";

function nowIso(): string {
  return new Date().toISOString();
}

function summarizeMarkdown(input: string, fallback: string, maxLength = 1200): string {
  const redacted = redactSecrets(input).trim();
  if (!redacted) {
    return fallback;
  }

  const normalized = redacted
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength).trimEnd()}\n\n...truncated for group chat brief...`;
}

function fileTimestamp(root: string, name: string): string {
  const filePath = bridgePath(root, name);
  if (!pathExists(filePath)) {
    return "missing";
  }

  return fs.statSync(filePath).mtime.toISOString();
}

function yesNo(value: boolean): "yes" | "no" {
  return value ? "yes" : "no";
}

function changedFilesList(files: string[]): string {
  return files.length ? files.map((file) => `- ${file}`).join("\n") : "- None";
}

function readLatestTest(root: string): string {
  return readTextIfExists(bridgePath(root, "logs/latest_test.txt"), "No latest test log found.");
}

function decisionTemplate(): string {
  return `${generatedNotice}

# Group Decision

## Decision Summary

Paste the decision from ChatGPT group chat here.

## Selected Next Action

- [ ] continue current approach
- [ ] revise plan
- [ ] ask Codex to implement
- [ ] ask Codex to fix tests
- [ ] stop and review manually

## Instructions For Codex

Describe the exact implementation or investigation Codex should do next.

## Constraints

- Do not expose secrets.
- Do not run destructive commands without approval.
- Keep changes focused.

## Acceptance Criteria

- [ ] Build passes.
- [ ] Relevant tests pass.
- [ ] Result is summarized back to AgentBridge.
`;
}

export function createGroupBrief(rootInput = process.cwd()): CommandResult {
  const root = resolveProjectRoot(rootInput);
  ensureProjectScaffold(root);

  const session = readSession(root);
  const git = getGitInfo(root, "short");
  const pendingApprovals = listApprovals(root, "pending");
  const chatGptPlan = readTextIfExists(bridgePath(root, "chatgpt_plan.md"));
  const codexTask = readTextIfExists(bridgePath(root, "codex_prompt.md"));
  const codexResult = readTextIfExists(bridgePath(root, "codex_result.md"));
  const latestTest = readLatestTest(root);

  const content = redactSecrets(`${generatedNotice}

# Group Chat Brief

## Purpose

Use this brief in ChatGPT group chat for coordination only. AgentBridge remains the source of truth.

## Project

- Project name: ${session.project_name}
- Project root: ${session.project_root}
- Branch: ${git.branch}
- Generated at: ${nowIso()}

## Git Status

\`\`\`text
${git.status}
\`\`\`

## Changed Files

${changedFilesList(git.changedFiles)}

## Session

- Status: ${session.status}
- Last test status: ${session.last_test_status}
- Next action: ${session.next_action}
- User goal: ${session.user_goal}

## Current ChatGPT Plan Summary

${summarizeMarkdown(chatGptPlan, "No ChatGPT plan has been written yet.")}

## Current Codex Task Summary

${summarizeMarkdown(codexTask, "No Codex task has been created yet.")}

## Current Codex Result Summary

${summarizeMarkdown(codexResult, "No Codex result has been submitted yet.")}

## Latest Test Log Summary

${summarizeMarkdown(latestTest, "No latest test log found.", 800)}

## Unresolved Risks

- Pending approvals: ${pendingApprovals.length}
- Review whether changed files are expected before asking Codex to continue.
- Do not paste secrets, local tokens, private keys, or raw .env values into group chat.

## Question For Group Chat

What should AgentBridge ask Codex to do next, and what acceptance criteria should be used?
`);

  writeText(bridgePath(root, GROUP_BRIEF), content);
  appendAudit(root, "group.brief", { changed_files: git.changedFiles.length, pending_approvals: pendingApprovals.length });

  return {
    bridgeDir: getBridgeDir(root),
    message: `Created .agentbridge/${GROUP_BRIEF}\nCopy this file into your ChatGPT group chat.`,
    changedFiles: [GROUP_BRIEF, "audit.jsonl"]
  };
}

export function createGroupHandoff(rootInput = process.cwd()): CommandResult {
  const root = resolveProjectRoot(rootInput);
  ensureProjectScaffold(root);

  const session = readSession(root);
  const git = getGitInfo(root, "short");
  const codexResult = readTextIfExists(bridgePath(root, "codex_result.md"));
  const latestTest = readLatestTest(root);

  const content = redactSecrets(`${generatedNotice}

# Group Chat Handoff

## Purpose

Use this handoff when Codex has finished work and the group needs to review the result.

## Session Summary

- Project: ${session.project_name}
- Root: ${session.project_root}
- Branch: ${git.branch}
- Status: ${session.status}
- Last test status: ${session.last_test_status}
- Next action: ${session.next_action}
- Generated at: ${nowIso()}

## What Codex Changed

${summarizeMarkdown(codexResult, "No Codex result has been submitted yet.")}

## Files Changed

${changedFilesList(git.changedFiles)}

## Commands Run And Tests

${summarizeMarkdown(latestTest, "No latest test log found.", 1000)}

## Risks

- Verify whether the changed files match the user goal.
- Confirm tests are sufficient for the blast radius.
- Keep secrets and tokens out of group chat.

## Questions For ChatGPT Group

- Did Codex satisfy the user intent?
- Are there missing tests or edge cases?
- Should AgentBridge ask Codex to continue, fix tests, revise the plan, or stop for manual review?

## Decision Needed

Copy the group decision into .agentbridge/group_decision.md, then run \`agentbridge group apply-decision\`.
`);

  writeText(bridgePath(root, GROUP_HANDOFF), content);
  appendAudit(root, "group.handoff", { changed_files: git.changedFiles.length });

  return {
    bridgeDir: getBridgeDir(root),
    message: `Created .agentbridge/${GROUP_HANDOFF}\nCopy this file into your ChatGPT group chat for review.`,
    changedFiles: [GROUP_HANDOFF, "audit.jsonl"]
  };
}

export function createGroupDecisionTemplate(rootInput = process.cwd()): CommandResult {
  const root = resolveProjectRoot(rootInput);
  ensureProjectScaffold(root);

  const created = writeTextIfMissing(bridgePath(root, GROUP_DECISION), decisionTemplate());
  appendAudit(root, "group.decision_template", { created });

  return {
    bridgeDir: getBridgeDir(root),
    message: created
      ? `Created .agentbridge/${GROUP_DECISION}`
      : `.agentbridge/${GROUP_DECISION} already exists; existing decision was preserved.`,
    changedFiles: created ? [GROUP_DECISION, "audit.jsonl"] : ["audit.jsonl"]
  };
}

export function applyGroupDecision(rootInput = process.cwd()): CommandResult {
  const root = resolveProjectRoot(rootInput);
  ensureProjectScaffold(root);

  const decisionPath = bridgePath(root, GROUP_DECISION);
  if (!pathExists(decisionPath)) {
    throw new Error("Group decision not found. Run `agentbridge group decision-template` first.");
  }

  const rawDecision = readTextIfExists(decisionPath);
  const decision = redactSecrets(rawDecision).trim();
  if (!decision) {
    throw new Error("Group decision is empty.");
  }
  if (decision !== rawDecision.trim()) {
    writeText(decisionPath, `${decision}\n`);
  }

  const plan = `${generatedNotice}

# ChatGPT Plan

## Source

Imported from .agentbridge/group_decision.md.

## Group Decision

${decision}
`;

  writeText(bridgePath(root, "chatgpt_plan.md"), redactSecrets(plan));
  writeText(
    bridgePath(root, "next_action.md"),
    `${generatedNotice}

# Next Action

Group decision applied. Use \`.agentbridge/codex_prompt.md\` as the next Codex task, or ask Codex to call \`get_next_task\`.
`
  );
  updateSession(root, {
    status: "planning",
    chatgpt_plan_status: "ready",
    next_action: "create_codex_prompt"
  });

  createCodexPrompt(root);
  appendAudit(root, "group.apply_decision", { decision_length: decision.length });

  return {
    bridgeDir: getBridgeDir(root),
    message: "Applied group decision and regenerated .agentbridge/codex_prompt.md.",
    changedFiles: ["chatgpt_plan.md", "next_action.md", "session.json", "codex_prompt.md", "audit.jsonl"]
  };
}

export function getGroupStatus(rootInput = process.cwd()): string {
  const root = resolveProjectRoot(rootInput);
  ensureProjectScaffold(root);

  const briefPath = bridgePath(root, GROUP_BRIEF);
  const handoffPath = bridgePath(root, GROUP_HANDOFF);
  const decisionPath = bridgePath(root, GROUP_DECISION);
  const hasBrief = pathExists(briefPath);
  const hasHandoff = pathExists(handoffPath);
  const hasDecision = pathExists(decisionPath);
  const session = readSession(root);

  let nextRecommendedStep =
    session.status === "result_ready" || session.status === "review_ready"
      ? "Run `agentbridge group handoff` for group review."
      : "Run `agentbridge group brief`.";
  if (hasBrief && !hasDecision) {
    nextRecommendedStep = "Copy group_brief.md into group chat, then run `agentbridge group decision-template`.";
  } else if (hasDecision) {
    nextRecommendedStep = "Fill group_decision.md with the group decision, then run `agentbridge group apply-decision`.";
  }

  return `Group Chat Companion Status

Bridge dir: ${getBridgeDir(root)}
Group brief exists: ${yesNo(hasBrief)}
Group handoff exists: ${yesNo(hasHandoff)}
Group decision exists: ${yesNo(hasDecision)}
Group brief last generated at: ${fileTimestamp(root, GROUP_BRIEF)}
Group handoff last generated at: ${fileTimestamp(root, GROUP_HANDOFF)}
Group decision last updated at: ${fileTimestamp(root, GROUP_DECISION)}
Next recommended step: ${nextRecommendedStep}
`;
}
