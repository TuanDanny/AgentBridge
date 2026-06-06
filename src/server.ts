import fs from "node:fs";
import http from "node:http";
import { URL } from "node:url";
import { ensureLocalToken, isAuthorized } from "./auth.js";
import { createChatGptReview, createCodexPrompt } from "./core.js";
import { dashboardHtml } from "./dashboard.js";
import { appendText, pathExists, readTextIfExists, writeJson, writeText } from "./fsx.js";
import { getGitInfo } from "./git.js";
import { createCodexChangesSummary, createProjectInspectorSnapshot } from "./inspector.js";
import { bridgePath, getBridgeDir, resolveProjectRoot } from "./paths.js";
import { getProjectTree, ProjectFileError, readProjectFile, searchProjectFiles, searchProjectText } from "./projectFiles.js";
import { redactSecrets } from "./redact.js";
import { findProject, listProjects, projectIdFromRoot, projectRootHint, touchProject, validateProjectId, type RegisteredProject } from "./registry.js";
import { classifyCommand, createApproval, listApprovals, resolveApproval } from "./safety.js";
import { appendAudit, ensureProjectScaffold, readSession, updateSession } from "./session.js";
import {
  addSessionHandoff,
  appendSessionEvidence,
  appendSessionEvent,
  getProjectSession,
  getSessionSummary,
  getSessionUpdates,
  SessionStoreError,
  setSessionGoal,
  updateSessionHandoff
} from "./sessionStore.js";
import type {
  AppendSessionEvidenceInput,
  SessionActor,
  SessionCurrentStatus,
  SessionEventType,
  SessionHandoffStatus,
  SessionPhase
} from "./sessionTypes.js";
import type { AgentBridgeSession, RiskLevel, ServerInfo, ServerOptions } from "./types.js";
import { readActiveProject, selectActiveProject } from "./activeProject.js";

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

type ProjectListMode = "registry" | "current_project_fallback";

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

function stringArrayField(body: unknown, field: string): string[] | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  const value = (body as Record<string, unknown>)[field];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return value;
}

function numberField(body: unknown, field: string): number | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  const value = (body as Record<string, unknown>)[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return value;
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
    id: projectIdFromRoot(root),
    name,
    root,
    registered: false,
    last_seen_at: session.updated_at
  };
}

function registeredInspectorProject(project: RegisteredProject): InspectorProjectRoute {
  return {
    id: project.id,
    name: project.name,
    root: project.root,
    registered: true,
    last_seen_at: project.last_seen
  };
}

function inspectorProjects(root: string): { mode: ProjectListMode; projects: InspectorProjectRoute[] } {
  const registered = listProjects(root);
  return registered.length
    ? { mode: "registry", projects: registered.map(registeredInspectorProject) }
    : { mode: "current_project_fallback", projects: [currentInspectorProject(root)] };
}

function findInspectorProject(root: string, projectId: string): InspectorProjectRoute | undefined {
  let id: string;
  try {
    id = validateProjectId(projectId);
  } catch {
    return undefined;
  }

  const registered = listProjects(root);
  if (registered.length) {
    const project = findProject(root, id);
    return project ? registeredInspectorProject(project) : undefined;
  }

  const currentProject = currentInspectorProject(root);
  return currentProject.id.toLowerCase() === id.toLowerCase() ? currentProject : undefined;
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
      message: "Project is not registered. Run agentbridge project register or agentbridge project register-current first."
    }
  });
}

function sendProjectFileError(response: http.ServerResponse, error: unknown): void {
  if (error instanceof ProjectFileError) {
    sendJson(response, error.status, {
      ok: false,
      ...projectFileErrorCoverage(error),
      error: {
        code: error.code,
        message: error.message
      }
    });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  sendJson(response, 400, { ok: false, error: { code: "invalid_query", message } });
}

function sendSessionStoreError(response: http.ServerResponse, error: unknown): void {
  if (error instanceof SessionStoreError) {
    sendJson(response, error.status, {
      ok: false,
      error: {
        code: error.code,
        message: error.message
      }
    });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  sendJson(response, 400, { ok: false, error: { code: "invalid_session_request", message } });
}

function recordHttpEvidence(
  registryRoot: string,
  projectId: string,
  input: Omit<AppendSessionEvidenceInput, "actor" | "source">
): void {
  appendSessionEvidence(registryRoot, projectId, {
    ...input,
    actor: "chatgpt",
    source: "http"
  });
}

function projectFileReadStatusFromError(error: ProjectFileError): "blocked" | "error" {
  if (error.code === "blocked_sensitive_file" || error.code === "binary_file") {
    return "blocked";
  }
  return "error";
}

function truncatedEvidenceStatus(truncated: boolean): "complete" | "truncated" {
  return truncated ? "truncated" : "complete";
}

function repoStatusCounts(statusShort: string): { staged_count: number; unstaged_count: number; untracked_count: number } {
  return statusShort
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("##"))
    .reduce(
      (counts, line) => {
        const code = line.slice(0, 2);
        if (code === "??") {
          counts.untracked_count += 1;
          return counts;
        }
        if (code[0] && code[0] !== " ") {
          counts.staged_count += 1;
        }
        if (code[1] && code[1] !== " ") {
          counts.unstaged_count += 1;
        }
        return counts;
      },
      { staged_count: 0, unstaged_count: 0, untracked_count: 0 }
    );
}

function headMetadata(recentCommits: string[]): { head_short_sha?: string; head_message?: string } {
  const head = recentCommits[0];
  if (!head) {
    return {};
  }
  const match = /^([0-9a-f]{6,40})\s+(.*)$/i.exec(head);
  if (!match) {
    return { head_message: head };
  }
  return { head_short_sha: match[1], head_message: match[2] };
}

function projectFileErrorCoverage(error: ProjectFileError): {
  read_status: "blocked" | "binary" | "not_found" | "error";
  blocked_reason?: string;
  truncated: false;
  coverage_warning: string;
} {
  if (error.code === "blocked_sensitive_file") {
    return {
      read_status: "blocked",
      blocked_reason: "sensitive_file_policy",
      truncated: false,
      coverage_warning: "Sensitive file blocked. Contents were not read."
    };
  }
  if (error.code === "binary_file") {
    return {
      read_status: "binary",
      blocked_reason: "binary_file",
      truncated: false,
      coverage_warning: "Binary file blocked. Contents were not read."
    };
  }
  if (error.code === "not_found") {
    return {
      read_status: "not_found",
      truncated: false,
      coverage_warning: "Requested file was not found. Contents were not read."
    };
  }
  return {
    read_status: "error",
    truncated: false,
    coverage_warning: "Requested file was not read."
  };
}

function queryInteger(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (value === null) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer.`);
  }
  return Number.parseInt(value, 10);
}

function queryBoolean(url: URL, name: string): boolean | undefined {
  const value = url.searchParams.get(name);
  if (value === null) {
    return undefined;
  }
  if (value !== "true" && value !== "false") {
    throw new Error(`${name} must be true or false.`);
  }
  return value === "true";
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
        const snapshot = createProjectInspectorSnapshot(root);
        sendJson(response, 200, {
          ok: true,
          review: snapshot.codex.review_packet_summary,
          root_hint: snapshot.project.root_hint,
          stale: snapshot.codex.review_packet_stale,
          ...(snapshot.codex.review_packet_stale_reason ? { stale_reason: snapshot.codex.review_packet_stale_reason } : {}),
          tests: snapshot.tests,
          approvals: snapshot.safety.approvals
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/chatgpt/projects") {
        const projectList = inspectorProjects(root);
        const projects = projectList.projects.map((project) => {
          const git = getGitInfo(project.root, "short");
          return {
            id: project.id,
            name: project.name,
            root_hint: redactSecrets(projectRootHint(project.root)),
            registered: project.registered,
            git_available: git.available,
            branch: git.branch,
            clean: git.available ? git.changedFiles.length === 0 : false,
            last_seen: project.last_seen_at
          };
        });
        sendJson(response, 200, { ok: true, mode: projectList.mode, projects });
        return;
      }

      if (request.method === "GET" && url.pathname === "/chatgpt/active-project") {
        sendJson(response, 200, readActiveProject(root));
        return;
      }

      const selectProjectRoute = /^\/chatgpt\/projects\/([^/]+)\/select$/.exec(url.pathname);
      if (request.method === "POST" && selectProjectRoute) {
        let projectId: string;
        try {
          projectId = decodeURIComponent(selectProjectRoute[1]);
          validateProjectId(projectId);
        } catch {
          sendProjectNotFound(response);
          return;
        }

        if (!listProjects(root).length || !findProject(root, projectId)) {
          sendProjectNotFound(response);
          return;
        }

        const active = selectActiveProject(root, projectId, "chatgpt_action");
        appendAudit(root, "http.chatgpt.project.select", { project_id: projectId });
        sendJson(response, 200, active);
        return;
      }

      const sessionRoute = /^\/chatgpt\/projects\/([^/]+)\/session$/.exec(url.pathname);
      if (request.method === "GET" && sessionRoute) {
        let projectId: string;
        try {
          projectId = decodeURIComponent(sessionRoute[1]);
        } catch {
          sendJson(response, 400, { ok: false, error: { code: "invalid_project_id", message: "Project id is not valid URL encoding." } });
          return;
        }
        const project = findInspectorProject(root, projectId);
        if (!project) {
          sendProjectNotFound(response);
          return;
        }
        try {
          if (project.registered) {
            touchProject(root, project.id);
          }
          sendJson(response, 200, getProjectSession(root, project.id));
        } catch (error) {
          sendSessionStoreError(response, error);
        }
        return;
      }

      const sessionSummaryRoute = /^\/chatgpt\/projects\/([^/]+)\/session\/summary$/.exec(url.pathname);
      if (request.method === "GET" && sessionSummaryRoute) {
        let projectId: string;
        try {
          projectId = decodeURIComponent(sessionSummaryRoute[1]);
        } catch {
          sendJson(response, 400, { ok: false, error: { code: "invalid_project_id", message: "Project id is not valid URL encoding." } });
          return;
        }
        const project = findInspectorProject(root, projectId);
        if (!project) {
          sendProjectNotFound(response);
          return;
        }
        try {
          if (project.registered) {
            touchProject(root, project.id);
          }
          sendJson(response, 200, { ok: true, summary: getSessionSummary(root, project.id) });
        } catch (error) {
          sendSessionStoreError(response, error);
        }
        return;
      }

      const sessionUpdatesRoute = /^\/chatgpt\/projects\/([^/]+)\/session\/updates$/.exec(url.pathname);
      if (request.method === "GET" && sessionUpdatesRoute) {
        let projectId: string;
        try {
          projectId = decodeURIComponent(sessionUpdatesRoute[1]);
        } catch {
          sendJson(response, 400, { ok: false, error: { code: "invalid_project_id", message: "Project id is not valid URL encoding." } });
          return;
        }
        const project = findInspectorProject(root, projectId);
        if (!project) {
          sendProjectNotFound(response);
          return;
        }
        try {
          if (project.registered) {
            touchProject(root, project.id);
          }
          sendJson(response, 200, getSessionUpdates(root, project.id, queryInteger(url, "since_revision") ?? 0));
        } catch (error) {
          sendSessionStoreError(response, error);
        }
        return;
      }

      const sessionEventRoute = /^\/chatgpt\/projects\/([^/]+)\/session\/events$/.exec(url.pathname);
      if (request.method === "POST" && sessionEventRoute) {
        let projectId: string;
        try {
          projectId = decodeURIComponent(sessionEventRoute[1]);
        } catch {
          sendJson(response, 400, { ok: false, error: { code: "invalid_project_id", message: "Project id is not valid URL encoding." } });
          return;
        }
        const project = findInspectorProject(root, projectId);
        if (!project) {
          sendProjectNotFound(response);
          return;
        }
        try {
          const body = await readRequestBody(request);
          if (project.registered) {
            touchProject(root, project.id);
          }
          sendJson(
            response,
            200,
            appendSessionEvent(root, project.id, {
              actor: (stringField(body, "actor") ?? "") as SessionActor,
              type: (stringField(body, "type") ?? "") as SessionEventType,
              summary: stringField(body, "summary") ?? "",
              details: stringField(body, "details"),
              expected_revision: numberField(body, "expected_revision")
            })
          );
        } catch (error) {
          sendSessionStoreError(response, error);
        }
        return;
      }

      const sessionHandoffRoute = /^\/chatgpt\/projects\/([^/]+)\/session\/handoffs$/.exec(url.pathname);
      if (request.method === "POST" && sessionHandoffRoute) {
        let projectId: string;
        try {
          projectId = decodeURIComponent(sessionHandoffRoute[1]);
        } catch {
          sendJson(response, 400, { ok: false, error: { code: "invalid_project_id", message: "Project id is not valid URL encoding." } });
          return;
        }
        const project = findInspectorProject(root, projectId);
        if (!project) {
          sendProjectNotFound(response);
          return;
        }
        try {
          const body = await readRequestBody(request);
          if (project.registered) {
            touchProject(root, project.id);
          }
          sendJson(
            response,
            200,
            addSessionHandoff(root, project.id, {
              from: (stringField(body, "from") ?? "chatgpt") as SessionActor,
              to: (stringField(body, "to") ?? "") as SessionActor,
              title: stringField(body, "title") ?? "",
              message: stringField(body, "message") ?? "",
              constraints: stringArrayField(body, "constraints"),
              expected_output: stringArrayField(body, "expected_output"),
              expected_revision: numberField(body, "expected_revision")
            })
          );
        } catch (error) {
          sendSessionStoreError(response, error);
        }
        return;
      }

      const sessionHandoffUpdateRoute = /^\/chatgpt\/projects\/([^/]+)\/session\/handoffs\/([^/]+)$/.exec(url.pathname);
      if (request.method === "POST" && sessionHandoffUpdateRoute) {
        let projectId: string;
        let handoffId: string;
        try {
          projectId = decodeURIComponent(sessionHandoffUpdateRoute[1]);
          handoffId = decodeURIComponent(sessionHandoffUpdateRoute[2]);
        } catch {
          sendJson(response, 400, { ok: false, error: { code: "invalid_project_id", message: "Project id or handoff id is not valid URL encoding." } });
          return;
        }
        const project = findInspectorProject(root, projectId);
        if (!project) {
          sendProjectNotFound(response);
          return;
        }
        try {
          const body = await readRequestBody(request);
          if (project.registered) {
            touchProject(root, project.id);
          }
          sendJson(
            response,
            200,
            updateSessionHandoff(root, project.id, handoffId, {
              actor: (stringField(body, "actor") ?? "codex") as SessionActor,
              status: (stringField(body, "status") ?? "") as SessionHandoffStatus,
              result_summary: stringField(body, "result_summary"),
              expected_revision: numberField(body, "expected_revision")
            })
          );
        } catch (error) {
          sendSessionStoreError(response, error);
        }
        return;
      }

      const sessionGoalRoute = /^\/chatgpt\/projects\/([^/]+)\/session\/goal$/.exec(url.pathname);
      if (request.method === "POST" && sessionGoalRoute) {
        let projectId: string;
        try {
          projectId = decodeURIComponent(sessionGoalRoute[1]);
        } catch {
          sendJson(response, 400, { ok: false, error: { code: "invalid_project_id", message: "Project id is not valid URL encoding." } });
          return;
        }
        const project = findInspectorProject(root, projectId);
        if (!project) {
          sendProjectNotFound(response);
          return;
        }
        try {
          const body = await readRequestBody(request);
          if (project.registered) {
            touchProject(root, project.id);
          }
          sendJson(
            response,
            200,
            setSessionGoal(root, project.id, {
              actor: (stringField(body, "actor") ?? "chatgpt") as SessionActor,
              goal: stringField(body, "goal") ?? "",
              phase: stringField(body, "phase") as SessionPhase | undefined,
              status: stringField(body, "status") as SessionCurrentStatus | undefined,
              expected_revision: numberField(body, "expected_revision")
            })
          );
        } catch (error) {
          sendSessionStoreError(response, error);
        }
        return;
      }

      const treeRoute = /^\/chatgpt\/projects\/([^/]+)\/tree$/.exec(url.pathname);
      if (request.method === "GET" && treeRoute) {
        let projectId: string;
        try {
          projectId = decodeURIComponent(treeRoute[1]);
        } catch {
          sendJson(response, 400, { ok: false, error: { code: "invalid_project_id", message: "Project id is not valid URL encoding." } });
          return;
        }
        const project = findInspectorProject(root, projectId);
        if (!project) {
          sendProjectNotFound(response);
          return;
        }
        try {
          if (project.registered) {
            touchProject(root, project.id);
          }
          const tree = getProjectTree(project.root, {
            projectId: project.id,
            maxDepth: queryInteger(url, "max_depth"),
            maxEntries: queryInteger(url, "max_entries"),
            includeHidden: queryBoolean(url, "include_hidden"),
            includeSizes: queryBoolean(url, "include_sizes")
          });
          recordHttpEvidence(root, project.id, {
            kind: "tree_seen",
            status: truncatedEvidenceStatus(tree.truncated),
            metadata: {
              max_depth: tree.max_depth,
              max_entries: tree.max_entries,
              returned_entries: tree.returned_entries,
              total_files: tree.total_files,
              total_folders: tree.total_folders,
              truncated: tree.truncated,
              tree_truncated: tree.inventory.tree_truncated,
              coverage_warning: tree.coverage_warning?.message ?? null,
              scale_hint: tree.inventory.scale_hint
            }
          });
          sendJson(response, 200, tree);
        } catch (error) {
          sendProjectFileError(response, error);
        }
        return;
      }

      const fileSearchRoute = /^\/chatgpt\/projects\/([^/]+)\/files\/search$/.exec(url.pathname);
      if (request.method === "GET" && fileSearchRoute) {
        let projectId: string;
        try {
          projectId = decodeURIComponent(fileSearchRoute[1]);
        } catch {
          sendJson(response, 400, { ok: false, error: { code: "invalid_project_id", message: "Project id is not valid URL encoding." } });
          return;
        }
        const project = findInspectorProject(root, projectId);
        if (!project) {
          sendProjectNotFound(response);
          return;
        }
        try {
          if (project.registered) {
            touchProject(root, project.id);
          }
          const search = searchProjectFiles(project.root, {
            projectId: project.id,
            query: url.searchParams.get("q") ?? "",
            maxResults: queryInteger(url, "max_results"),
            maxDepth: queryInteger(url, "max_depth"),
            caseSensitive: queryBoolean(url, "case_sensitive")
          });
          recordHttpEvidence(root, project.id, {
            kind: "file_search",
            status: truncatedEvidenceStatus(search.truncated),
            metadata: {
              query: search.query,
              result_count: search.matches.length,
              truncated: search.truncated
            }
          });
          sendJson(response, 200, search);
        } catch (error) {
          sendProjectFileError(response, error);
        }
        return;
      }

      const readFileRoute = /^\/chatgpt\/projects\/([^/]+)\/file$/.exec(url.pathname);
      if (request.method === "GET" && readFileRoute) {
        let projectId: string;
        try {
          projectId = decodeURIComponent(readFileRoute[1]);
        } catch {
          sendJson(response, 400, { ok: false, error: { code: "invalid_project_id", message: "Project id is not valid URL encoding." } });
          return;
        }
        const project = findInspectorProject(root, projectId);
        if (!project) {
          sendProjectNotFound(response);
          return;
        }
        try {
          if (project.registered) {
            touchProject(root, project.id);
          }
          const fileRead = readProjectFile(project.root, {
            projectId: project.id,
            relativePath: url.searchParams.get("path") ?? "",
            maxChars: queryInteger(url, "max_chars"),
            startLine: queryInteger(url, "start_line"),
            numLines: queryInteger(url, "num_lines")
          });
          recordHttpEvidence(root, project.id, {
            kind: "file_read",
            path: fileRead.path,
            status: fileRead.read_status === "complete" ? "complete" : "partial",
            metadata: {
              read_status: fileRead.read_status,
              bytes_returned: fileRead.bytes_returned,
              truncated: fileRead.truncated,
              line_count: fileRead.line_count,
              line_count_estimate: fileRead.line_count_estimate,
              line_range_returned: fileRead.line_range_returned,
              coverage_warning: fileRead.coverage_warning,
              redacted: fileRead.redacted,
              size: fileRead.size
            }
          });
          sendJson(response, 200, fileRead);
        } catch (error) {
          if (error instanceof ProjectFileError) {
            recordHttpEvidence(root, project.id, {
              kind: "file_read",
              path: url.searchParams.get("path") ?? "",
              status: projectFileReadStatusFromError(error),
              metadata: {
                error_code: error.code,
                status: error.status,
                blocked: error.code === "blocked_sensitive_file" || error.code === "binary_file"
              }
            });
          }
          sendProjectFileError(response, error);
        }
        return;
      }

      const grepRoute = /^\/chatgpt\/projects\/([^/]+)\/grep$/.exec(url.pathname);
      if (request.method === "GET" && grepRoute) {
        let projectId: string;
        try {
          projectId = decodeURIComponent(grepRoute[1]);
        } catch {
          sendJson(response, 400, { ok: false, error: { code: "invalid_project_id", message: "Project id is not valid URL encoding." } });
          return;
        }
        const project = findInspectorProject(root, projectId);
        if (!project) {
          sendProjectNotFound(response);
          return;
        }
        try {
          if (project.registered) {
            touchProject(root, project.id);
          }
          const grep = searchProjectText(project.root, {
            projectId: project.id,
            query: url.searchParams.get("q") ?? "",
            maxMatches: queryInteger(url, "max_matches"),
            maxFileSize: queryInteger(url, "max_file_size"),
            maxDepth: queryInteger(url, "max_depth"),
            caseSensitive: queryBoolean(url, "case_sensitive")
          });
          recordHttpEvidence(root, project.id, {
            kind: "grep_seen",
            status: truncatedEvidenceStatus(grep.truncated),
            metadata: {
              query: grep.query,
              match_count: grep.matches.length,
              files_matched_count: new Set(grep.matches.map((match) => match.path)).size,
              truncated: grep.truncated,
              redacted: grep.redacted
            }
          });
          sendJson(response, 200, grep);
        } catch (error) {
          sendProjectFileError(response, error);
        }
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
          if (project.registered) {
            touchProject(root, project.id);
          }
          const snapshot = createProjectInspectorSnapshot(project.root, commonOptions);
          snapshot.project.root_hint = redactSecrets(projectRootHint(project.root));
          recordHttpEvidence(root, project.id, {
            kind: "inspect_seen",
            status: snapshot.limits.truncated ? "partial" : "complete",
            metadata: {
              branch: snapshot.repo.branch,
              clean: snapshot.repo.clean,
              changed_count: snapshot.repo.changed_files.length,
              ...repoStatusCounts(snapshot.repo.status_short),
              ...headMetadata(snapshot.repo.recent_commits),
              pending_approvals: snapshot.safety.pending_approvals,
              diff_truncated: snapshot.limits.diff_truncated
            }
          });
          sendJson(response, 200, snapshot);
          return;
        }

        if (inspectorRoute[2] === "codex-changes") {
          if (project.registered) {
            touchProject(root, project.id);
          }
          const changes = createCodexChangesSummary(project.root, commonOptions);
          recordHttpEvidence(root, project.id, {
            kind: "codex_changes_seen",
            status: changes.limits.truncated ? "partial" : "complete",
            metadata: {
              branch: changes.branch,
              clean: changes.clean,
              changed_count: changes.changed_files.length,
              diff_truncated: changes.limits.diff_truncated
            }
          });
          sendJson(response, 200, changes);
          return;
        }

        if (project.registered) {
          touchProject(root, project.id);
        }
        const snapshot = createProjectInspectorSnapshot(project.root, commonOptions);
        snapshot.project.root_hint = redactSecrets(projectRootHint(project.root));
        recordHttpEvidence(root, project.id, {
          kind: "review_packet_seen",
          status: snapshot.limits.truncated ? "partial" : "complete",
          metadata: {
            stale: snapshot.codex.review_packet_stale,
            changed_count: snapshot.codex.changed_file_summary.length,
            tests_stale: snapshot.tests.stale,
            approvals_count: snapshot.safety.approvals.length
          }
        });
        sendJson(response, 200, {
          ok: true,
          project_id: snapshot.project.id,
          review_packet: {
            root_hint: snapshot.project.root_hint,
            summary: snapshot.codex.review_packet_summary,
            stale: snapshot.codex.review_packet_stale,
            ...(snapshot.codex.review_packet_stale_reason ? { stale_reason: snapshot.codex.review_packet_stale_reason } : {}),
            files_changed: snapshot.codex.changed_file_summary,
            tests: snapshot.tests,
            risks: snapshot.safety.risk_flags,
            approvals: snapshot.safety.approvals,
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
        sendJson(response, 200, { ok: true, registry: { version: 1, projects: listProjects(root) } });
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
