import path from "node:path";
import { appendJsonLine, ensureDir, readJsonIfExists, writeJson, writeTextIfMissing } from "./fsx.js";
import { bridgePath, getBridgeDir, getProjectName } from "./paths.js";
import {
  chatGptPlanTemplate,
  codexResultTemplate,
  configTemplate,
  nextActionTemplate,
  userIntentTemplate
} from "./templates.js";
import type { AgentBridgeSession, AuditEvent } from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function createSessionId(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function createDefaultSession(root: string): AgentBridgeSession {
  const createdAt = nowIso();
  return {
    session_id: createSessionId(),
    project_root: root,
    project_name: getProjectName(root),
    status: "initialized",
    user_goal: "Describe the coding task in .agentbridge/user_intent.md.",
    active_branch: "unavailable",
    chatgpt_plan_status: "missing",
    codex_task_status: "missing",
    last_test_status: "unknown",
    next_action: "capture_project_context",
    created_at: createdAt,
    updated_at: createdAt
  };
}

export function readSession(root: string): AgentBridgeSession {
  return readJsonIfExists<AgentBridgeSession>(bridgePath(root, "session.json")) ?? createDefaultSession(root);
}

export function writeSession(root: string, session: AgentBridgeSession): void {
  writeJson(bridgePath(root, "session.json"), {
    ...session,
    updated_at: nowIso()
  });
}

export function updateSession(
  root: string,
  update: Partial<Omit<AgentBridgeSession, "created_at" | "updated_at" | "session_id" | "project_root" | "project_name">>
): AgentBridgeSession {
  const current = readSession(root);
  const next: AgentBridgeSession = {
    ...current,
    ...update,
    project_root: root,
    project_name: getProjectName(root)
  };
  writeSession(root, next);
  return readSession(root);
}

export function ensureProjectScaffold(root: string): string[] {
  const bridgeDir = getBridgeDir(root);
  ensureDir(bridgeDir);
  ensureDir(path.join(bridgeDir, "snapshots"));
  ensureDir(path.join(bridgeDir, "logs"));

  const created: string[] = [];
  const create = (name: string, content: string): void => {
    const filePath = bridgePath(root, name);
    if (writeTextIfMissing(filePath, content)) {
      created.push(name);
    }
  };

  create("config.toml", configTemplate());
  create("session.json", `${JSON.stringify(createDefaultSession(root), null, 2)}\n`);
  create("user_intent.md", userIntentTemplate());
  create("chatgpt_plan.md", chatGptPlanTemplate());
  create("codex_progress.md", "# Codex Progress\n\nNo progress reported yet.\n");
  create("codex_result.md", codexResultTemplate());
  create("next_action.md", nextActionTemplate());
  create("approvals.json", "[]\n");
  create("approval_queue.jsonl", "");
  create("audit.jsonl", "");

  return created;
}

export function appendAudit(root: string, action: string, details: Record<string, unknown>): void {
  const event: AuditEvent = {
    timestamp: nowIso(),
    action,
    details
  };
  appendJsonLine(bridgePath(root, "audit.jsonl"), event);
}
