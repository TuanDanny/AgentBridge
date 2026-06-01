import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import { appendText, readTextIfExists, writeText } from "./fsx.js";
import { getGitInfo } from "./git.js";
import { bridgePath, resolveProjectRoot } from "./paths.js";
import { redactSecrets } from "./redact.js";
import { classifyCommand, createApproval } from "./safety.js";
import { appendAudit, ensureProjectScaffold, readSession, updateSession } from "./session.js";
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
