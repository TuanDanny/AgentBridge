import fs from "node:fs";
import { createHash } from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { ensureLocalToken, isAuthorized } from "./auth.js";
import { createChatGptReview, createCodexPrompt } from "./core.js";
import { dashboardHtml } from "./dashboard.js";
import { appendText, pathExists, readTextIfExists, writeJson, writeText } from "./fsx.js";
import { getGitInfo } from "./git.js";
import { createCodexChangesSummary, createProjectInspectorSnapshot, projectIdFromName } from "./inspector.js";
import { bridgePath, getBridgeDir, resolveProjectRoot } from "./paths.js";
import { redactSecrets } from "./redact.js";
import { listProjects, type RegisteredProject } from "./registry.js";
import { classifyCommand, createApproval, listApprovals, resolveApproval } from "./safety.js";
import { appendAudit, ensureProjectScaffold, readSession, updateSession } from "./session.js";
import type { AgentBridgeSession, RiskLevel, ServerInfo, ServerOptions } from "./types.js";

export interface RunningAgentBridgeServer {
  server: http.Server;
  info: ServerInfo;
  close: () => Promise<void>;
}

type SessionSummary = Pick<
  AgentBridgeSession,
  | "session_id"
  | "project_root"
  | "project_name"
  | "status"
  | "user_goal"
  | "active_branch"
  | "chatgpt_plan_status"
  | "codex_task_status"
  | "last_test_status"
  | "next_action"
  | "updated_at"
>;

interface InspectorProjectRoute {
  id: string;
  name: string;
  root: string;
  registered: boolean;
  last_seen_at: string;
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  response.end(payload);
}

function sendHtml(response: http.ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function readRequestBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("Request body too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Request body must be JSON."));
      }
    });
    request.on("error", reject);
  });
}

function stringField(body: unknown, field: string): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function isRiskLevel(value: string): value is RiskLevel {
  return value === "low" || value === "medium" || value === "high";
}

function readSessionSummary(root: string): SessionSummary {
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

function readRedactedTextIfExists(filePath: string, fallback = ""): string {
  return redactSecrets(readTextIfExists(filePath, fallback));
}

function readRepoStatus(root: string): {
  available: boolean;
  branch: string;
  status: string;
  changed_files: string[];
  error: string | null;
} {
  const git = getGitInfo(root, "short");
  return {
    available: git.available,
    branch: git.branch,
    status: git.status,
    changed_files: git.changedFiles,
    error: git.error ?? null
  };
}

function currentInspectorProject(root: string): InspectorProjectRoute {
  const session = readSession(root);
  const name = session.project_name;
  return {
    id: projectIdFromName(name),
    name,
    root,
    registered: false,
    last_seen_at: session.updated_at
  };
}

function registeredInspectorProject(project: RegisteredProject): InspectorProjectRoute {
  const rootHash = createHash("sha256").update(project.project_root.toLowerCase()).digest("hex").slice(0, 8);
  return {
    id: `${projectIdFromName(project.project_name)}-${rootHash}`,
    name: project.project_name,
    root: project.project_root,
    registered: true,
    last_seen_at: project.last_seen_at
  };
}

function inspectorProjects(root: string): InspectorProjectRoute[] {
  const registered = listProjects();
  return registered.length ? registered.map(registeredInspectorProject) : [currentInspectorProject(root)];
}

function findInspectorProject(root: string, projectId: string): InspectorProjectRoute | undefined {
  const normalized = projectId.toLowerCase();
  return inspectorProjects(root).find((project) => project.id.toLowerCase() === normalized);
}

function parseInspectorOptions(url: URL): { maxCharsPerField?: number; includeDiff?: boolean } {
  const maxCharsParam = url.searchParams.get("max_chars") ?? url.searchParams.get("max_diff_chars");
  let maxCharsPerField: number | undefined;
  if (maxCharsParam !== null) {
    const parsed = Number.parseInt(maxCharsParam, 10);
    if (!Number.isInteger(parsed) || parsed < 200 || parsed > 50000) {
      throw new Error("Invalid max_chars. Use an integer from 200 to 50000.");
    }
    maxCharsPerField = parsed;
  }

  const mode = url.searchParams.get("mode");
  if (mode && !["summary", "standard", "deep", "full"].includes(mode)) {
    throw new Error("Invalid mode. Use summary, standard, deep, or full.");
  }

  const includeDiffParam = url.searchParams.get("include_diff");
  if (includeDiffParam && !["true", "false"].includes(includeDiffParam)) {
    throw new Error("Invalid include_diff. Use true or false.");
  }

  return {
    maxCharsPerField,
    includeDiff: includeDiffParam === "true" || mode === "deep" || mode === "full"
  };
}

function sendProjectNotFound(response: http.ServerResponse): void {
  sendJson(response, 404, {
    ok: false,
    error: {
      code: "project_not_found",
      message: "Project is not registered. Run agentbridge projects add first."
    }
  });
}

function writeServerInfo(root: string, info: ServerInfo): void {
  writeJson(bridgePath(root, "server.json"), info);
}

function removeServerInfo(root: string): void {
  fs.rmSync(bridgePath(root, "server.json"), { force: true });
}

export async function startAgentBridgeServer(
  rootInput = process.cwd(),
  options: Partial<ServerOptions> = {}
): Promise<RunningAgentBridgeServer> {
  const root = resolveProjectRoot(rootInput);
  ensureProjectScaffold(root);
  const token = ensureLocalToken(root);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 7777;
  const startedAt = new Date().toISOString();
  let lastChangedAt = startedAt;
  let watcher: fs.FSWatcher | undefined;

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          name: "agentbridge",
          started_at: startedAt,
          last_changed_at: lastChangedAt
        });
        return;
      }

      if (!isAuthorized(request.headers, token)) {
        sendJson(response, 401, { ok: false, error: "Unauthorized." });
        return;
      }

      if (request.method === "GET" && url.pathname === "/dashboard") {
        sendHtml(response, 200, dashboardHtml(token));
        return;
      }

      if (request.method === "GET" && url.pathname === "/chatgpt/session-summary") {
        sendJson(response, 200, { ok: true, session: readSessionSummary(root) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/chatgpt/repo-status") {
        sendJson(response, 200, { ok: true, ...readRepoStatus(root) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/chatgpt/context") {
        const filePath = bridgePath(root, "project_context.md");
        if (!pathExists(filePath)) {
          sendJson(response, 404, {
            ok: false,
            error: "Project context has not been captured yet. Run agentbridge capture."
          });
          return;
        }

        sendJson(response, 200, { ok: true, context: readRedactedTextIfExists(filePath) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/chatgpt/next-task") {
        sendJson(response, 200, {
          ok: true,
          task: readRedactedTextIfExists(
            bridgePath(root, "codex_prompt.md"),
            "No Codex prompt found. Run agentbridge prompt or POST /chatgpt/create-codex-prompt."
          )
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/chatgpt/review-packet") {
        sendJson(response, 200, {
          ok: true,
          review: readRedactedTextIfExists(
            bridgePath(root, "chatgpt_review.md"),
            "No ChatGPT review packet found. Run agentbridge review or POST /review."
          )
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/chatgpt/projects") {
        const projects = inspectorProjects(root).map((project) => {
          const git = getGitInfo(project.root, "short");
          return {
            id: project.id,
            name: project.name,
            root_hint: redactSecrets(project.root),
            registered: project.registered,
            branch: git.branch,
            clean: git.available ? git.changedFiles.length === 0 : false,
            last_seen: project.last_seen_at
          };
        });
        sendJson(response, 200, { ok: true, projects });
        return;
      }

      const inspectorRoute = /^\/chatgpt\/projects\/([^/]+)\/(inspect|codex-changes|review-packet)$/.exec(url.pathname);
      if (request.method === "GET" && inspectorRoute) {
        let projectId: string;
        try {
          projectId = decodeURIComponent(inspectorRoute[1]);
        } catch {
          sendJson(response, 400, {
            ok: false,
            error: { code: "invalid_project_id", message: "Project id is not valid URL encoding." }
          });
          return;
        }

        const project = findInspectorProject(root, projectId);
        if (!project) {
          sendProjectNotFound(response);
          return;
        }

        let inspectorOptions: { maxCharsPerField?: number; includeDiff?: boolean };
        try {
          inspectorOptions = parseInspectorOptions(url);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(response, 400, { ok: false, error: { code: "invalid_query", message } });
          return;
        }

        const commonOptions = {
          ...inspectorOptions,
          projectId: project.id,
          projectName: project.name,
          registered: project.registered
        };

        if (inspectorRoute[2] === "inspect") {
          sendJson(response, 200, createProjectInspectorSnapshot(project.root, commonOptions));
          return;
        }

        if (inspectorRoute[2] === "codex-changes") {
          sendJson(response, 200, createCodexChangesSummary(project.root, commonOptions));
          return;
        }

        const snapshot = createProjectInspectorSnapshot(project.root, commonOptions);
        sendJson(response, 200, {
          ok: true,
          project_id: snapshot.project.id,
          review_packet: {
            summary: snapshot.codex.review_packet_summary,
            files_changed: snapshot.codex.changed_file_summary,
            tests: snapshot.tests.latest_summary,
            risks: snapshot.safety.risk_flags,
            questions_for_chatgpt: [
              "Did Codex satisfy the current user goal?",
              "Are the tests sufficient for the changed files?",
              "What should AgentBridge ask Codex to do next?"
            ]
          },
          limits: snapshot.limits
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/session") {
        sendJson(response, 200, { ok: true, session: readSession(root) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/context") {
        const context = readTextIfExists(bridgePath(root, "project_context.md"));
        if (!context) {
          sendJson(response, 404, { ok: false, error: "Project context has not been captured yet." });
          return;
        }
        sendJson(response, 200, { ok: true, context: redactSecrets(context) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/chatgpt/plan") {
        sendJson(response, 200, {
          ok: true,
          plan: readRedactedTextIfExists(bridgePath(root, "chatgpt_plan.md"), "No ChatGPT plan found.")
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/codex/task") {
        sendJson(response, 200, {
          ok: true,
          task: readRedactedTextIfExists(bridgePath(root, "codex_prompt.md"), "No Codex prompt found.")
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/codex/result") {
        sendJson(response, 200, {
          ok: true,
          result: readRedactedTextIfExists(bridgePath(root, "codex_result.md"), "No Codex result found.")
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/repo/status") {
        sendJson(response, 200, { ok: true, ...readRepoStatus(root) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/repo/diff") {
        const mode = url.searchParams.get("mode") === "raw" ? "raw" : "full";
        const git = getGitInfo(root, mode);
        sendJson(response, 200, {
          ok: true,
          available: git.available,
          diff_stat: git.diffStat,
          diff: git.diff,
          error: git.error
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/tests/latest") {
        const latest = readTextIfExists(bridgePath(root, "logs/latest_test.txt"));
        sendJson(response, 200, {
          ok: true,
          status: latest ? "available" : "unknown",
          output: latest || "No latest test log found."
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/codex/progress") {
        sendJson(response, 200, {
          ok: true,
          progress: readRedactedTextIfExists(
            bridgePath(root, "codex_progress.md"),
            "# Codex Progress\n\nNo progress reported yet.\n"
          )
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/approvals") {
        const status = url.searchParams.get("status") ?? undefined;
        if (status && !["pending", "approved", "rejected", "expired"].includes(status)) {
          sendJson(response, 400, { ok: false, error: "Invalid approval status." });
          return;
        }
        sendJson(response, 200, { ok: true, approvals: listApprovals(root, status as never) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/projects") {
        sendJson(response, 200, { ok: true, projects: listProjects() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/chatgpt/plan") {
        const body = await readRequestBody(request);
        const plan = stringField(body, "plan");
        if (!plan) {
          sendJson(response, 400, { ok: false, error: "Missing string field: plan." });
          return;
        }

        const userGoal = stringField(body, "user_goal");
        writeText(bridgePath(root, "chatgpt_plan.md"), redactSecrets(plan));
        const session = updateSession(root, {
          status: "planning",
          user_goal: userGoal ? redactSecrets(userGoal) : readSession(root).user_goal,
          chatgpt_plan_status: "ready",
          next_action: "create_codex_prompt"
        });
        appendAudit(root, "http.chatgpt.plan", { plan_length: plan.length, user_goal: userGoal ? redactSecrets(userGoal) : undefined });
        sendJson(response, 200, { ok: true, session });
        return;
      }

      if (request.method === "POST" && url.pathname === "/chatgpt/create-codex-prompt") {
        const body = await readRequestBody(request);
        const plan = stringField(body, "plan");
        const userGoal = stringField(body, "user_goal");

        if (plan) {
          writeText(bridgePath(root, "chatgpt_plan.md"), redactSecrets(plan));
        }

        if (plan || userGoal) {
          updateSession(root, {
            status: plan ? "planning" : readSession(root).status,
            user_goal: userGoal ? redactSecrets(userGoal) : readSession(root).user_goal,
            chatgpt_plan_status: plan ? "ready" : readSession(root).chatgpt_plan_status,
            next_action: "create_codex_prompt"
          });
        }

        createCodexPrompt(root);
        appendAudit(root, "http.chatgpt.create_prompt", {
          plan_length: plan?.length ?? 0,
          has_user_goal: Boolean(userGoal)
        });
        sendJson(response, 200, {
          ok: true,
          prompt: readRedactedTextIfExists(bridgePath(root, "codex_prompt.md")),
          session: readSessionSummary(root)
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/chatgpt/report-progress") {
        const body = await readRequestBody(request);
        const progress = stringField(body, "progress");
        if (!progress) {
          sendJson(response, 400, { ok: false, error: "Missing string field: progress." });
          return;
        }

        const entry = `\n## ${new Date().toISOString()}\n\n${redactSecrets(progress).trim()}\n`;
        appendText(bridgePath(root, "codex_progress.md"), entry);
        updateSession(root, {
          status: "codex_working",
          codex_task_status: "working",
          next_action: "codex_submit_result"
        });
        appendAudit(root, "http.chatgpt.progress", { progress_length: progress.length });
        sendJson(response, 200, { ok: true, session: readSessionSummary(root) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/chatgpt/submit-codex-result") {
        const body = await readRequestBody(request);
        const result = stringField(body, "result");
        if (!result) {
          sendJson(response, 400, { ok: false, error: "Missing string field: result." });
          return;
        }

        writeText(bridgePath(root, "codex_result.md"), redactSecrets(result));
        updateSession(root, {
          status: "result_ready",
          codex_task_status: "submitted",
          next_action: "review_codex_result"
        });
        appendAudit(root, "http.chatgpt.result", { result_length: result.length });
        sendJson(response, 200, { ok: true, session: readSessionSummary(root) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/chatgpt/classify-command") {
        const body = await readRequestBody(request);
        const command = stringField(body, "command");
        if (!command) {
          sendJson(response, 400, { ok: false, error: "Missing string field: command." });
          return;
        }

        const risk = classifyCommand(command);
        appendAudit(root, "http.chatgpt.classify_command", {
          command: redactSecrets(command),
          risk: risk.risk,
          blocked: risk.blocked
        });
        sendJson(response, 200, { ok: true, ...risk });
        return;
      }

      if (request.method === "POST" && url.pathname === "/chatgpt/request-approval") {
        const body = await readRequestBody(request);
        const action = stringField(body, "action");
        if (!action) {
          sendJson(response, 400, { ok: false, error: "Missing string field: action." });
          return;
        }

        const riskInput = stringField(body, "risk");
        if (riskInput && !isRiskLevel(riskInput)) {
          sendJson(response, 400, { ok: false, error: "Invalid approval risk." });
          return;
        }
        const risk = riskInput && isRiskLevel(riskInput) ? riskInput : undefined;

        const approval = createApproval(root, {
          actor: stringField(body, "actor") ?? "chatgpt",
          action,
          command: stringField(body, "command"),
          reason: stringField(body, "reason"),
          risk
        });
        appendAudit(root, "http.chatgpt.approval.request", {
          id: approval.id,
          actor: approval.actor,
          action: approval.action,
          risk: approval.risk
        });
        sendJson(response, 200, { ok: true, approval });
        return;
      }

      if (request.method === "POST" && url.pathname === "/codex/result") {
        const body = await readRequestBody(request);
        const result = stringField(body, "result");
        if (!result) {
          sendJson(response, 400, { ok: false, error: "Missing string field: result." });
          return;
        }

        writeText(bridgePath(root, "codex_result.md"), redactSecrets(result));
        const session = updateSession(root, {
          status: "result_ready",
          codex_task_status: "submitted",
          next_action: "review_codex_result"
        });
        appendAudit(root, "http.codex.result", { result_length: result.length });
        sendJson(response, 200, { ok: true, session });
        return;
      }

      if (request.method === "POST" && url.pathname === "/codex/prompt") {
        createCodexPrompt(root);
        sendJson(response, 200, {
          ok: true,
          task: readTextIfExists(bridgePath(root, "codex_prompt.md")),
          session: readSession(root)
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/review") {
        createChatGptReview(root);
        sendJson(response, 200, {
          ok: true,
          review: readTextIfExists(bridgePath(root, "chatgpt_review.md")),
          session: readSession(root)
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/approval/request") {
        const body = await readRequestBody(request);
        const action = stringField(body, "action");
        if (!action) {
          sendJson(response, 400, { ok: false, error: "Missing string field: action." });
          return;
        }

        const approval = createApproval(root, {
          actor: stringField(body, "actor") ?? "codex",
          action,
          command: stringField(body, "command"),
          reason: stringField(body, "reason")
        });
        appendAudit(root, "http.approval.request", { id: approval.id, action: approval.action, risk: approval.risk });
        sendJson(response, 200, { ok: true, approval });
        return;
      }

      if (request.method === "POST" && (url.pathname === "/approve" || url.pathname === "/reject")) {
        const action = url.pathname === "/approve" ? "approved" : "rejected";
        const body = await readRequestBody(request);
        const id = stringField(body, "id");
        if (id) {
          const approval = resolveApproval(root, id, action);
          appendAudit(root, `http.${action}`, { id });
          sendJson(response, 200, { ok: true, status: action, approval });
          return;
        }

        appendAudit(root, `http.${action}`, { body });
        sendJson(response, 200, { ok: true, status: action });
        return;
      }

      if (request.method === "POST" && url.pathname === "/shutdown") {
        appendAudit(root, "http.shutdown", { pid: process.pid });
        sendJson(response, 200, { ok: true, status: "shutting_down" });
        setTimeout(() => {
          void closeServer();
        }, 10);
        return;
      }

      sendJson(response, 404, { ok: false, error: "Not found." });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { ok: false, error: message });
    }
  });

  const closeServer = async (): Promise<void> => {
    watcher?.close();
    removeServerInfo(root);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const info: ServerInfo = {
    host,
    port: actualPort,
    pid: process.pid,
    project_root: root,
    bridge_dir: getBridgeDir(root),
    started_at: startedAt
  };
  writeServerInfo(root, info);

  watcher = fs.watch(getBridgeDir(root), { persistent: false }, () => {
    lastChangedAt = new Date().toISOString();
  });

  process.once("SIGINT", () => {
    void closeServer().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void closeServer().finally(() => process.exit(0));
  });

  return { server, info, close: closeServer };
}
