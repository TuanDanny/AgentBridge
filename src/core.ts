import { bridgePath, getBridgeDir, resolveProjectRoot } from "./paths.js";
import { readTextIfExists, writeText, writeTextIfMissing } from "./fsx.js";
import { getGitInfo } from "./git.js";
import { redactSecrets } from "./redact.js";
import { chatGptReviewTemplate, codexPromptTemplate, codexResultTemplate, projectContextTemplate } from "./templates.js";
import { appendAudit, ensureProjectScaffold, readSession, updateSession } from "./session.js";
import type { CaptureMode, CommandResult } from "./types.js";

function validateCaptureMode(mode: string): CaptureMode {
  if (mode === "short" || mode === "full" || mode === "raw") {
    return mode;
  }

  throw new Error(`Invalid capture mode "${mode}". Use short, full, or raw.`);
}

function detectPlanStatus(plan: string): "missing" | "draft" | "ready" {
  const normalized = plan.trim();
  if (!normalized) {
    return "missing";
  }

  if (normalized.includes("Describe the intended outcome.")) {
    return "draft";
  }

  return "ready";
}

export function initProject(rootInput = process.cwd()): CommandResult {
  const root = resolveProjectRoot(rootInput);
  const createdFiles = ensureProjectScaffold(root);
  const git = getGitInfo(root, "short");
  const session = updateSession(root, {
    status: "initialized",
    active_branch: git.branch,
    next_action: "capture_project_context"
  });
  appendAudit(root, "init", { createdFiles, session_id: session.session_id });

  return {
    bridgeDir: getBridgeDir(root),
    message: createdFiles.length
      ? `Initialized AgentBridge session with ${createdFiles.length} new files.`
      : "AgentBridge session already initialized.",
    changedFiles: createdFiles
  };
}

export function captureProject(rootInput = process.cwd(), modeInput = "short"): CommandResult {
  const root = resolveProjectRoot(rootInput);
  const mode = validateCaptureMode(modeInput);
  ensureProjectScaffold(root);

  const git = getGitInfo(root, mode);
  const session = updateSession(root, {
    status: "captured",
    active_branch: git.branch,
    next_action: "create_codex_prompt"
  });
  const content = projectContextTemplate(session, git, mode);
  writeText(bridgePath(root, "project_context.md"), redactSecrets(content));
  appendAudit(root, "capture", { mode, git_available: git.available, changed_files: git.changedFiles.length });

  return {
    bridgeDir: getBridgeDir(root),
    message: `Captured ${mode} project context.`,
    changedFiles: ["project_context.md", "session.json", "audit.jsonl"]
  };
}

export function createCodexPrompt(rootInput = process.cwd()): CommandResult {
  const root = resolveProjectRoot(rootInput);
  ensureProjectScaffold(root);

  const userIntent = readTextIfExists(bridgePath(root, "user_intent.md"));
  const projectContext = readTextIfExists(bridgePath(root, "project_context.md"));
  const chatGptPlan = readTextIfExists(bridgePath(root, "chatgpt_plan.md"));
  const sessionBefore = readSession(root);
  const prompt = codexPromptTemplate({
    sessionGoal: sessionBefore.user_goal,
    userIntent,
    projectContext,
    chatGptPlan
  });
  writeText(bridgePath(root, "codex_prompt.md"), redactSecrets(prompt));
  const session = updateSession(root, {
    status: "prompt_ready",
    chatgpt_plan_status: detectPlanStatus(chatGptPlan),
    codex_task_status: "ready",
    next_action: "codex_execute_prompt"
  });
  appendAudit(root, "prompt", { session_id: session.session_id });

  return {
    bridgeDir: getBridgeDir(root),
    message: "Created Codex prompt.",
    changedFiles: ["codex_prompt.md", "session.json", "audit.jsonl"]
  };
}

export function prepareCodexResult(rootInput = process.cwd()): CommandResult {
  const root = resolveProjectRoot(rootInput);
  ensureProjectScaffold(root);

  const created = writeTextIfMissing(bridgePath(root, "codex_result.md"), codexResultTemplate());
  const session = updateSession(root, {
    status: "result_ready",
    codex_task_status: "submitted",
    next_action: "review_codex_result"
  });
  appendAudit(root, "result", { created, session_id: session.session_id });

  return {
    bridgeDir: getBridgeDir(root),
    message: created ? "Created Codex result template." : "Codex result file already exists.",
    changedFiles: created ? ["codex_result.md", "session.json", "audit.jsonl"] : ["session.json", "audit.jsonl"]
  };
}

export function createChatGptReview(rootInput = process.cwd()): CommandResult {
  const root = resolveProjectRoot(rootInput);
  ensureProjectScaffold(root);

  const sessionBefore = readSession(root);
  const content = chatGptReviewTemplate({
    session: sessionBefore,
    userIntent: readTextIfExists(bridgePath(root, "user_intent.md")),
    chatGptPlan: readTextIfExists(bridgePath(root, "chatgpt_plan.md")),
    projectContext: readTextIfExists(bridgePath(root, "project_context.md")),
    codexResult: readTextIfExists(bridgePath(root, "codex_result.md"))
  });
  writeText(bridgePath(root, "chatgpt_review.md"), redactSecrets(content));
  const session = updateSession(root, {
    status: "review_ready",
    next_action: "user_review"
  });
  appendAudit(root, "review", { session_id: session.session_id });

  return {
    bridgeDir: getBridgeDir(root),
    message: "Created ChatGPT review packet.",
    changedFiles: ["chatgpt_review.md", "session.json", "audit.jsonl"]
  };
}

export function getStatus(rootInput = process.cwd()): string {
  const root = resolveProjectRoot(rootInput);
  ensureProjectScaffold(root);
  const session = readSession(root);

  return `AgentBridge status

Project: ${session.project_name}
Root: ${session.project_root}
Session: ${session.session_id}
Status: ${session.status}
Branch: ${session.active_branch}
ChatGPT plan: ${session.chatgpt_plan_status}
Codex task: ${session.codex_task_status}
Last tests: ${session.last_test_status}
Next action: ${session.next_action}
Bridge dir: ${getBridgeDir(root)}
`;
}
