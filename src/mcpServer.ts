import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import { appendText, readTextIfExists, writeText } from "./fsx.js";
import { getGitInfo } from "./git.js";
import { bridgePath, resolveProjectRoot } from "./paths.js";
import { redactSecrets } from "./redact.js";
import { findProject, listProjects, projectIdFromRoot, validateProjectId } from "./registry.js";
import { classifyCommand, createApproval } from "./safety.js";
import { appendAudit, ensureProjectScaffold, readSession, updateSession } from "./session.js";
import {
  addSessionHandoff,
  appendSessionCheck,
  appendSessionEvent,
  bootstrapSession,
  getActivitySinceRevision,
  getSessionCompactContext,
  getOrCreateActiveSession,
  getRecentActivity,
  getSessionTimeline,
  getSessionSummary,
  getSessionUpdates,
  listSessionHandoffs,
  setSessionGoal,
  updateSessionHandoff
} from "./sessionStore.js";
import type { SessionHandoffStatus } from "./sessionTypes.js";
import { reconcileWorkspaceActivity } from "./workspaceActivity.js";
import {
  captureProject,
  createChatGptReview,
  createCodexPrompt
} from "./core.js";

function textResult(text: string, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    ...(structuredContent ? { structuredContent } : {})
  };
}

function readSessionSummary(root: string): Record<string, unknown> {
  const session = readSession(root);
  return {
    session_id: session.session_id,
    project_root: session.project_root,
    project_name: session.project_name,
    status: session.status,
    user_goal: session.user_goal,
    active_branch: session.active_branch,
    chatgpt_plan_status: session.chatgpt_plan_status,
    codex_task_status: session.codex_task_status,
    last_test_status: session.last_test_status,
    next_action: session.next_action,
    updated_at: session.updated_at
  };
}

const sessionActorSchema = z.enum(["user", "chatgpt", "codex", "system"]);
const sessionEventTypeSchema = z.enum([
  "note",
  "decision",
  "correction",
  "handoff",
  "implementation",
  "review",
  "test_result",
  "commit",
  "warning",
  "blocker"
]);
const sessionHandoffStatusSchema = z.enum(["open", "acknowledged", "in_progress", "done", "blocked", "cancelled", "superseded"]);
const sessionHandoffListStatusSchema = z.enum([
  "open",
  "acknowledged",
  "in_progress",
  "done",
  "blocked",
  "cancelled",
  "superseded",
  "active"
]);
const sessionPhaseSchema = z.enum(["planning", "implementation", "review", "blocked", "done"]);
const sessionCurrentStatusSchema = z.enum(["active", "in_progress", "blocked", "done"]);
const sessionCheckTypeSchema = z.enum(["build", "test", "diff_check", "workflow", "git_status", "smoke"]);
const sessionCheckStatusSchema = z.enum(["pass", "fail", "warning", "unknown", "skipped"]);
const sessionActivityKindSchema = z.enum([
  "session_bootstrap",
  "session_resume",
  "session_summary_read",
  "session_goal_set",
  "active_client_heartbeat",
  "handoff_seen",
  "handoff_added",
  "handoff_update",
  "handoff_acknowledged",
  "handoff_done",
  "handoff_blocked",
  "handoff_cancelled",
  "handoff_superseded",
  "file_create",
  "file_edit",
  "file_delete",
  "file_verify",
  "file_status",
  "file_diff_summary",
  "command_started",
  "command_finished",
  "check_logged",
  "test_passed",
  "test_failed",
  "build_passed",
  "build_failed",
  "tree_seen",
  "file_read_seen",
  "grep_seen",
  "inspect_seen",
  "evidence_recorded",
  "workspace_snapshot",
  "git_status_seen",
  "changed_files_summary",
  "activity_gap_detected",
  "launcher_started",
  "launcher_ready",
  "launcher_warn",
  "task_started",
  "task_progress",
  "task_complete",
  "task_blocked",
  "secret_redacted",
  "raw_content_blocked",
  "content_truncated",
  "unsafe_path_blocked"
]);
const sessionBootstrapClientSchema = z.enum(["codex", "chatgpt", "user", "system"]);
const sessionBootstrapAdapterSchema = z.enum(["mcp", "cli", "codex_plugin"]);
const sessionBootstrapModeSchema = z.enum(["start", "resume"]);
const activeHandoffStatuses = new Set<SessionHandoffStatus>(["open", "acknowledged", "in_progress", "blocked"]);

function sessionProjectId(root: string, projectId?: string): string {
  return projectId ? validateProjectId(projectId) : projectIdFromRoot(root);
}

function sessionProject(root: string, projectId?: string): { projectId: string; projectRoot: string } {
  const id = sessionProjectId(root, projectId);
  const projects = listProjects(root);
  if (projectId && projects.length) {
    const registered = findProject(root, id);
    if (!registered) {
      throw new Error("Project is not registered.");
    }
    return { projectId: registered.id, projectRoot: registered.root };
  }
  const registered = projects.find((project) => project.id.toLowerCase() === id.toLowerCase());
  return { projectId: registered?.id ?? id, projectRoot: registered?.root ?? root };
}

export function createAgentBridgeMcpServer(rootInput = process.cwd()): McpServer {
  const root = resolveProjectRoot(rootInput);
  ensureProjectScaffold(root);

  const server = new McpServer({
    name: "agentbridge",
    version: "0.1.0"
  });

  server.registerTool(
    "get_project_context",
    {
      title: "Get Project Context",
      description: "Capture and return redacted project context from the current AgentBridge session.",
      inputSchema: {
        mode: z.enum(["short", "full", "raw"]).optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ mode }) => {
      captureProject(root, mode ?? "short");
      const context = readTextIfExists(bridgePath(root, "project_context.md"));
      return textResult(context, {
        redacted: true,
        mode: mode ?? "short",
        session: readSessionSummary(root)
      });
    }
  );

  server.registerTool(
    "get_session_summary",
    {
      title: "Get Session Summary",
      description: "Return the current AgentBridge session summary.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => textResult(JSON.stringify(readSessionSummary(root), null, 2), readSessionSummary(root))
  );

  server.registerTool(
    "session_bootstrap",
    {
      title: "Bootstrap Shared Session",
      description: "Create or resume a shared session, update CodexLink heartbeat, and return compact next-action context.",
      inputSchema: {
        project_id: z.string().optional(),
        actor: sessionActorSchema.default("codex"),
        client: sessionBootstrapClientSchema.default("codex"),
        adapter: sessionBootstrapAdapterSchema.default("mcp"),
        source: z.string().optional(),
        mode: sessionBootstrapModeSchema.default("start")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ project_id, actor, client, adapter, source, mode }) => {
      const projectId = sessionProjectId(root, project_id);
      const result = bootstrapSession(root, projectId, {
        actor,
        client,
        adapter,
        source: source ?? "mcp",
        mode
      });
      return textResult(JSON.stringify(result, null, 2), { ...result });
    }
  );

  server.registerTool(
    "session_active",
    {
      title: "Get Shared Session Active",
      description: "Get or create the active shared workspace session for a project.",
      inputSchema: {
        project_id: z.string().optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ project_id }) => {
      const projectId = sessionProjectId(root, project_id);
      const view = getOrCreateActiveSession(root, projectId);
      const structured = {
        ok: true,
        project_id: projectId,
        session_id: view.active_session.session_id,
        revision: view.active_session.revision,
        active_session: view.active_session,
        summary: view.summary
      };
      return textResult(JSON.stringify(structured, null, 2), structured);
    }
  );

  server.registerTool(
    "session_summary",
    {
      title: "Get Shared Session Summary",
      description: "Return the shared workspace session summary for Codex/local MCP use.",
      inputSchema: {
        project_id: z.string().optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ project_id }) => {
      const projectId = sessionProjectId(root, project_id);
      const summary = getSessionSummary(root, projectId);
      return textResult(JSON.stringify({ ok: true, summary }, null, 2), { ok: true, summary });
    }
  );

  server.registerTool(
    "session_updates",
    {
      title: "Get Shared Session Updates",
      description: "Return shared session events and handoffs after a revision.",
      inputSchema: {
        project_id: z.string().optional(),
        since_revision: z.number().int().min(0).default(0)
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ project_id, since_revision }) => {
      const projectId = sessionProjectId(root, project_id);
      const updates = getSessionUpdates(root, projectId, since_revision);
      return textResult(JSON.stringify(updates, null, 2), { ...updates });
    }
  );

  server.registerTool(
    "session_activity",
    {
      title: "Get Shared Session Activity",
      description: "Return recent redacted Activity Trace timeline metadata for a shared session.",
      inputSchema: {
        project_id: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(20),
        kind: sessionActivityKindSchema.optional(),
        since_revision: z.number().int().min(0).optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ project_id, limit, kind, since_revision }) => {
      const projectId = sessionProjectId(root, project_id);
      const result =
        since_revision !== undefined
          ? getActivitySinceRevision(root, projectId, since_revision)
          : getRecentActivity(root, projectId, limit);
      const activities = (result.activities ?? []).filter((activity) => (kind ? activity.kind === kind : true));
      const structured = { ...result, activities };
      return textResult(JSON.stringify(structured, null, 2), structured);
    }
  );

  server.registerTool(
    "session_timeline",
    {
      title: "Get Shared Session Timeline",
      description: "Return a redacted Activity Trace timeline filtered by recent activity, handoff, task, or file.",
      inputSchema: {
        project_id: z.string().optional(),
        handoff_id: z.string().optional(),
        task_id: z.string().optional(),
        file_path: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20)
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ project_id, handoff_id, task_id, file_path, limit }) => {
      const projectId = sessionProjectId(root, project_id);
      const result = getSessionTimeline(root, projectId, {
        handoff_id,
        task_id,
        file_path,
        limit
      });
      return textResult(JSON.stringify(result, null, 2), { ...result });
    }
  );

  server.registerTool(
    "session_context",
    {
      title: "Get Shared Session Compact Context",
      description: "Return compact local memory context for resuming Codex/GPT work without raw content.",
      inputSchema: {
        project_id: z.string().optional(),
        compact: z.boolean().default(true)
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ project_id }) => {
      const projectId = sessionProjectId(root, project_id);
      const result = getSessionCompactContext(root, projectId);
      return textResult(JSON.stringify(result, null, 2), { ...result });
    }
  );

  server.registerTool(
    "session_reconcile",
    {
      title: "Reconcile Workspace Activity",
      description: "Record a safe workspace snapshot and activity gaps for changed files without storing raw content or diffs.",
      inputSchema: {
        project_id: z.string().optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ project_id }) => {
      const project = sessionProject(root, project_id);
      const result = reconcileWorkspaceActivity(root, project.projectRoot, project.projectId);
      return textResult(JSON.stringify(result, null, 2), { ...result });
    }
  );

  server.registerTool(
    "session_list_handoffs",
    {
      title: "List Shared Session Handoffs",
      description: "List shared session handoffs, optionally filtered by status.",
      inputSchema: {
        project_id: z.string().optional(),
        status: sessionHandoffListStatusSchema.optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ project_id, status }) => {
      const projectId = sessionProjectId(root, project_id);
      const result = listSessionHandoffs(root, projectId);
      const handoffs =
        status === "active"
          ? result.handoffs.filter((handoff) => activeHandoffStatuses.has(handoff.status))
          : status
            ? result.handoffs.filter((handoff) => handoff.status === status)
            : result.handoffs;
      const structured = { ok: true, project_id: projectId, handoffs };
      return textResult(JSON.stringify(structured, null, 2), structured);
    }
  );

  server.registerTool(
    "session_append_event",
    {
      title: "Append Shared Session Event",
      description: "Append a redacted event to the shared workspace session.",
      inputSchema: {
        project_id: z.string().optional(),
        actor: sessionActorSchema,
        type: sessionEventTypeSchema,
        summary: z.string(),
        details: z.string().optional(),
        expected_revision: z.number().int().min(0).optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ project_id, actor, type, summary, details, expected_revision }) => {
      const projectId = sessionProjectId(root, project_id);
      const result = appendSessionEvent(root, projectId, { actor, type, summary, details, expected_revision });
      return textResult(JSON.stringify(result, null, 2), result);
    }
  );

  server.registerTool(
    "session_add_handoff",
    {
      title: "Add Shared Session Handoff",
      description: "Create a redacted shared session handoff visible through CLI and GPT Actions.",
      inputSchema: {
        project_id: z.string().optional(),
        from: sessionActorSchema.default("codex"),
        to: sessionActorSchema,
        title: z.string(),
        message: z.string(),
        constraints: z.array(z.string()).optional(),
        expected_output: z.array(z.string()).optional(),
        expected_revision: z.number().int().min(0).optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ project_id, from, to, title, message, constraints, expected_output, expected_revision }) => {
      const projectId = sessionProjectId(root, project_id);
      const result = addSessionHandoff(root, projectId, {
        from,
        to,
        title,
        message,
        constraints,
        expected_output,
        expected_revision
      });
      return textResult(JSON.stringify(result, null, 2), result);
    }
  );

  server.registerTool(
    "session_update_handoff",
    {
      title: "Update Shared Session Handoff",
      description: "Update a shared session handoff status or result summary.",
      inputSchema: {
        project_id: z.string().optional(),
        handoff_id: z.string(),
        status: sessionHandoffStatusSchema,
        result_summary: z.string().optional(),
        expected_revision: z.number().int().min(0).optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ project_id, handoff_id, status, result_summary, expected_revision }) => {
      const projectId = sessionProjectId(root, project_id);
      const result = updateSessionHandoff(root, projectId, handoff_id, {
        actor: "codex",
        status,
        result_summary,
        expected_revision
      });
      return textResult(JSON.stringify(result, null, 2), result);
    }
  );

  server.registerTool(
    "session_set_goal",
    {
      title: "Set Shared Session Goal",
      description: "Set the shared workspace session goal, phase, and status.",
      inputSchema: {
        project_id: z.string().optional(),
        goal: z.string(),
        phase: sessionPhaseSchema.optional(),
        status: sessionCurrentStatusSchema.optional(),
        expected_revision: z.number().int().min(0).optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ project_id, goal, phase, status, expected_revision }) => {
      const projectId = sessionProjectId(root, project_id);
      const result = setSessionGoal(root, projectId, {
        actor: "codex",
        goal,
        phase,
        status,
        expected_revision
      });
      return textResult(JSON.stringify(result, null, 2), result);
    }
  );

  server.registerTool(
    "session_append_check",
    {
      title: "Append Shared Session Check",
      description: "Append redacted build/test/workflow check metadata without running a command.",
      inputSchema: {
        project_id: z.string().optional(),
        actor: sessionActorSchema.default("codex"),
        type: sessionCheckTypeSchema,
        status: sessionCheckStatusSchema,
        summary: z.string(),
        command: z.string().optional(),
        exit_code: z.number().int().min(0).optional(),
        duration_ms: z.number().int().min(0).optional(),
        expected_revision: z.number().int().min(0).optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ project_id, actor, type, status, summary, command, exit_code, duration_ms, expected_revision }) => {
      const projectId = sessionProjectId(root, project_id);
      const result = appendSessionCheck(root, projectId, {
        actor,
        type,
        status,
        summary,
        command,
        exit_code,
        duration_ms,
        expected_revision
      });
      return textResult(JSON.stringify(result, null, 2), result);
    }
  );

  server.registerTool(
    "create_codex_prompt",
    {
      title: "Create Codex Prompt",
      description: "Optionally save a ChatGPT plan, then create the Codex prompt file.",
      inputSchema: {
        plan: z.string().optional(),
        user_goal: z.string().optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ plan, user_goal }) => {
      if (plan) {
        writeText(bridgePath(root, "chatgpt_plan.md"), redactSecrets(plan));
        updateSession(root, {
          status: "planning",
          user_goal: user_goal ?? readSession(root).user_goal,
          chatgpt_plan_status: "ready",
          next_action: "create_codex_prompt"
        });
        appendAudit(root, "mcp.chatgpt.plan", { plan_length: plan.length, user_goal });
      }

      createCodexPrompt(root);
      const prompt = readTextIfExists(bridgePath(root, "codex_prompt.md"));
      return textResult(prompt, {
        prompt_path: bridgePath(root, "codex_prompt.md"),
        session: readSessionSummary(root)
      });
    }
  );

  server.registerTool(
    "get_next_task",
    {
      title: "Get Next Task",
      description: "Return the current Codex task prompt.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const task = readTextIfExists(
        bridgePath(root, "codex_prompt.md"),
        "No Codex prompt exists yet. Run create_codex_prompt first."
      );
      return textResult(task, {
        session: readSessionSummary(root)
      });
    }
  );

  server.registerTool(
    "report_progress",
    {
      title: "Report Codex Progress",
      description: "Append a Codex progress update to the shared session.",
      inputSchema: {
        progress: z.string()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ progress }) => {
      const entry = `\n## ${new Date().toISOString()}\n\n${redactSecrets(progress).trim()}\n`;
      appendText(bridgePath(root, "codex_progress.md"), entry);
      updateSession(root, {
        status: "codex_working",
        codex_task_status: "working",
        next_action: "codex_submit_result"
      });
      appendAudit(root, "mcp.codex.progress", { progress_length: progress.length });
      return textResult("Progress recorded.", {
        session: readSessionSummary(root)
      });
    }
  );

  server.registerTool(
    "submit_codex_result",
    {
      title: "Submit Codex Result",
      description: "Write the Codex result to the shared session.",
      inputSchema: {
        result: z.string()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ result }) => {
      writeText(bridgePath(root, "codex_result.md"), redactSecrets(result));
      updateSession(root, {
        status: "result_ready",
        codex_task_status: "submitted",
        next_action: "review_codex_result"
      });
      appendAudit(root, "mcp.codex.result", { result_length: result.length });
      return textResult("Codex result submitted.", {
        session: readSessionSummary(root)
      });
    }
  );

  server.registerTool(
    "review_codex_result",
    {
      title: "Review Codex Result",
      description: "Create and return the ChatGPT review packet.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      createChatGptReview(root);
      const review = readTextIfExists(bridgePath(root, "chatgpt_review.md"));
      return textResult(review, {
        review_path: bridgePath(root, "chatgpt_review.md"),
        session: readSessionSummary(root)
      });
    }
  );

  server.registerTool(
    "classify_command",
    {
      title: "Classify Command",
      description: "Classify command risk without running the command.",
      inputSchema: {
        command: z.string()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ command }) => {
      const risk = classifyCommand(command);
      return textResult(JSON.stringify(risk, null, 2), { ...risk });
    }
  );

  server.registerTool(
    "request_user_approval",
    {
      title: "Request User Approval",
      description: "Create a pending local approval request for a risky action.",
      inputSchema: {
        actor: z.string().default("codex"),
        action: z.string(),
        command: z.string().optional(),
        reason: z.string().optional(),
        risk: z.enum(["low", "medium", "high"]).default("medium")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ actor, action, command, reason, risk }) => {
      const approval = createApproval(root, {
        actor,
        action,
        command,
        reason,
        risk
      });
      appendAudit(root, "mcp.approval.request", { id: approval.id, actor, action, risk });
      return textResult(JSON.stringify(approval, null, 2), { ...approval });
    }
  );

  server.registerTool(
    "get_repo_status",
    {
      title: "Get Repo Status",
      description: "Return redacted git branch and status information.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const git = getGitInfo(root, "short");
      const structured = {
        available: git.available,
        branch: git.branch,
        status: git.status,
        changed_files: git.changedFiles,
        error: git.error
      };
      return textResult(JSON.stringify(structured, null, 2), structured);
    }
  );

  return server;
}

export async function runMcpStdioServer(rootInput = process.cwd()): Promise<void> {
  const server = createAgentBridgeMcpServer(rootInput);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("AgentBridge MCP server running on stdio.");
}
