import fs from "node:fs";
import http from "node:http";
import { URL } from "node:url";
import { ensureLocalToken, isAuthorized } from "./auth.js";
import { createChatGptReview, createCodexPrompt } from "./core.js";
import { dashboardHtml } from "./dashboard.js";
import { readTextIfExists, writeJson, writeText } from "./fsx.js";
import { getGitInfo } from "./git.js";
import { bridgePath, getBridgeDir, resolveProjectRoot } from "./paths.js";
import { redactSecrets } from "./redact.js";
import { listProjects } from "./registry.js";
import { createApproval, listApprovals, resolveApproval } from "./safety.js";
import { appendAudit, ensureProjectScaffold, readSession, updateSession } from "./session.js";
import type { ServerInfo, ServerOptions } from "./types.js";

export interface RunningAgentBridgeServer {
  server: http.Server;
  info: ServerInfo;
  close: () => Promise<void>;
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

      if (request.method === "GET" && url.pathname === "/dashboard") {
        sendHtml(response, 200, dashboardHtml(token));
        return;
      }

      if (!isAuthorized(request.headers, token)) {
        sendJson(response, 401, { ok: false, error: "Unauthorized." });
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
        sendJson(response, 200, { ok: true, context });
        return;
      }

      if (request.method === "GET" && url.pathname === "/chatgpt/plan") {
        sendJson(response, 200, {
          ok: true,
          plan: readTextIfExists(bridgePath(root, "chatgpt_plan.md"), "No ChatGPT plan found.")
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/codex/task") {
        sendJson(response, 200, {
          ok: true,
          task: readTextIfExists(bridgePath(root, "codex_prompt.md"), "No Codex prompt found.")
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/codex/result") {
        sendJson(response, 200, {
          ok: true,
          result: readTextIfExists(bridgePath(root, "codex_result.md"), "No Codex result found.")
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/repo/status") {
        const git = getGitInfo(root, "short");
        sendJson(response, 200, {
          ok: true,
          available: git.available,
          branch: git.branch,
          status: git.status,
          changed_files: git.changedFiles,
          error: git.error
        });
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
          progress: readTextIfExists(bridgePath(root, "codex_progress.md"), "# Codex Progress\n\nNo progress reported yet.\n")
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
          user_goal: userGoal ?? readSession(root).user_goal,
          chatgpt_plan_status: "ready",
          next_action: "create_codex_prompt"
        });
        appendAudit(root, "http.chatgpt.plan", { plan_length: plan.length, user_goal: userGoal });
        sendJson(response, 200, { ok: true, session });
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
