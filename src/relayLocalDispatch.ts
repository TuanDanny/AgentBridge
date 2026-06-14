import { getGitInfo } from "./git.js";
import { createCodexChangesSummary, createProjectInspectorSnapshot, type InspectorOptions } from "./inspector.js";
import { getProjectTree, readProjectFile, searchProjectFiles, searchProjectText } from "./projectFiles.js";
import { projectRootHint, findProject, listProjects, projectIdFromRoot, validateProjectId, type RegisteredProject } from "./registry.js";
import { redactSecrets } from "./redact.js";
import { getSessionCompactContext, getSessionSummary, getSessionTimeline, type SessionTimelineOptions } from "./sessionStore.js";
import { type RelayRequestEnvelope, validateRelayRequestEnvelope } from "./relayProtocol.js";

export interface RelayLocalDispatchResult {
  ok: boolean;
  operation_id: string;
  status: number;
  data?: unknown;
  error?: {
    code: string;
    message: string;
  };
  metadata: {
    validated: boolean;
    request_bytes: number;
    response_policy?: string;
    local_only: true;
    content_stored: false;
  };
}

export interface RelayLocalDispatchOptions {
  allowedProjectIds?: string[];
}

export function dispatchRelayRequestLocally(
  root = process.cwd(),
  envelope: RelayRequestEnvelope,
  options: RelayLocalDispatchOptions = {}
): RelayLocalDispatchResult {
  const validation = validateRelayRequestEnvelope(envelope);
  const baseMetadata = {
    validated: validation.ok,
    request_bytes: validation.request_bytes,
    response_policy: validation.route?.response_content_policy,
    local_only: true as const,
    content_stored: false as const
  };
  if (!validation.ok) {
    return {
      ok: false,
      operation_id: envelope.operation_id || "",
      status: 400,
      error: {
        code: "relay_request_rejected",
        message: validation.errors.join(" ")
      },
      metadata: baseMetadata
    };
  }

  try {
    switch (envelope.operation_id) {
      case "listProjects":
        return ok(envelope.operation_id, listRelayProjects(root, options.allowedProjectIds), baseMetadata);
      case "getSessionSummary":
        return ok(envelope.operation_id, getSessionSummary(root, requireRelayProjectId(root, envelope, options.allowedProjectIds)), baseMetadata);
      case "getSessionContext":
        return ok(envelope.operation_id, getSessionCompactContext(root, requireRelayProjectId(root, envelope, options.allowedProjectIds)), baseMetadata);
      case "getSessionTimeline":
        return ok(
          envelope.operation_id,
          getSessionTimeline(root, requireRelayProjectId(root, envelope, options.allowedProjectIds), relayTimelineOptions(envelope.body)),
          baseMetadata
        );
      case "inspectProject": {
        const project = requireRelayProject(root, envelope, options.allowedProjectIds);
        return ok(
          envelope.operation_id,
          createProjectInspectorSnapshot(project.root, {
            ...relayInspectorOptions(envelope.body),
            projectId: project.id,
            projectName: project.name,
            registered: project.registered
          }),
          baseMetadata
        );
      }
      case "getCodexChanges": {
        const project = requireRelayProject(root, envelope, options.allowedProjectIds);
        return ok(
          envelope.operation_id,
          createCodexChangesSummary(project.root, {
            ...relayInspectorOptions(envelope.body),
            projectId: project.id,
            projectName: project.name,
            registered: project.registered
          }),
          baseMetadata
        );
      }
      case "getReviewPacket": {
        const project = requireRelayProject(root, envelope, options.allowedProjectIds);
        const snapshot = createProjectInspectorSnapshot(project.root, {
          ...relayInspectorOptions(envelope.body),
          projectId: project.id,
          projectName: project.name,
          registered: project.registered
        });
        return ok(
          envelope.operation_id,
          {
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
          },
          baseMetadata
        );
      }
      case "getProjectTree": {
        const project = requireRelayProject(root, envelope, options.allowedProjectIds);
        const body = relayBody(envelope.body);
        return ok(
          envelope.operation_id,
          getProjectTree(project.root, {
            projectId: project.id,
            maxDepth: numberField(body, "max_depth"),
            maxEntries: numberField(body, "max_entries"),
            includeHidden: booleanField(body, "include_hidden"),
            includeSizes: booleanField(body, "include_sizes")
          }),
          baseMetadata
        );
      }
      case "searchProjectFiles": {
        const project = requireRelayProject(root, envelope, options.allowedProjectIds);
        const body = relayBody(envelope.body);
        return ok(
          envelope.operation_id,
          searchProjectFiles(project.root, {
            projectId: project.id,
            query: stringField(body, "q") ?? stringField(body, "query") ?? "",
            maxResults: numberField(body, "max_results"),
            maxDepth: numberField(body, "max_depth"),
            caseSensitive: booleanField(body, "case_sensitive")
          }),
          baseMetadata
        );
      }
      case "readProjectFile": {
        const project = requireRelayProject(root, envelope, options.allowedProjectIds);
        const body = relayBody(envelope.body);
        return ok(
          envelope.operation_id,
          readProjectFile(project.root, {
            projectId: project.id,
            relativePath: stringField(body, "path") ?? stringField(body, "relative_path") ?? "",
            maxChars: numberField(body, "max_chars"),
            startLine: numberField(body, "start_line"),
            numLines: numberField(body, "num_lines")
          }),
          baseMetadata
        );
      }
      case "searchProjectText": {
        const project = requireRelayProject(root, envelope, options.allowedProjectIds);
        const body = relayBody(envelope.body);
        return ok(
          envelope.operation_id,
          searchProjectText(project.root, {
            projectId: project.id,
            query: stringField(body, "q") ?? stringField(body, "query") ?? "",
            maxMatches: numberField(body, "max_matches"),
            maxFileSize: numberField(body, "max_file_size"),
            maxDepth: numberField(body, "max_depth"),
            caseSensitive: booleanField(body, "case_sensitive")
          }),
          baseMetadata
        );
      }
      default:
        return {
          ok: false,
          operation_id: envelope.operation_id,
          status: 404,
          error: {
            code: "relay_operation_not_implemented",
            message: "Relay operation is allowlisted but not implemented by the local dispatcher."
          },
          metadata: baseMetadata
        };
    }
  } catch (error) {
    return {
      ok: false,
      operation_id: envelope.operation_id,
      status: error instanceof Error && /not registered/i.test(error.message) ? 404 : 400,
      error: {
        code: "relay_dispatch_failed",
        message: error instanceof Error ? error.message : "Relay local dispatch failed."
      },
      metadata: baseMetadata
    };
  }
}

export function createRelayEnvelope(operationId: string, projectId?: string, body?: unknown): RelayRequestEnvelope {
  if (operationId === "listProjects") {
    return { operation_id: operationId, method: "GET", path: "/chatgpt/projects", body };
  }
  const safeProjectId = validateProjectId(projectId ?? "");
  const path = relayPathForOperation(operationId, safeProjectId);
  if (!path) {
    throw new Error("Unsupported relay operation.");
  }
  return {
    operation_id: operationId,
    method: "GET",
    path,
    project_id: safeProjectId,
    body
  };
}

function ok(operationId: string, data: unknown, metadata: RelayLocalDispatchResult["metadata"]): RelayLocalDispatchResult {
  return {
    ok: true,
    operation_id: operationId,
    status: 200,
    data,
    metadata
  };
}

function listRelayProjects(root: string, allowedProjectIds?: string[]): { mode: "registry" | "current_project_fallback"; projects: unknown[] } {
  const allowed = normalizeAllowedProjectIds(allowedProjectIds);
  const registered = listProjects(root);
  if (registered.length) {
    const projects = allowed ? registered.filter((project) => allowed.has(project.id.toLowerCase())) : registered;
    return {
      mode: "registry",
      projects: projects.map((project) => relayProjectSummary(project, true))
    };
  }
  const fallbackId = projectIdFromRoot(root);
  if (allowed && !allowed.has(fallbackId.toLowerCase())) {
    return {
      mode: "current_project_fallback",
      projects: []
    };
  }
  const git = getGitInfo(root, "short");
  return {
    mode: "current_project_fallback",
    projects: [
      {
        id: fallbackId,
        name: fallbackId,
        root_hint: redactSecrets(projectRootHint(root)),
        registered: false,
        git_available: git.available,
        branch: git.branch,
        clean: git.available ? git.changedFiles.length === 0 : null,
        last_seen: null
      }
    ]
  };
}

function relayProjectSummary(project: RegisteredProject, registered: boolean): unknown {
  const git = getGitInfo(project.root, "short");
  return {
    id: project.id,
    name: project.name,
    root_hint: redactSecrets(projectRootHint(project.root)),
    registered,
    git_available: git.available,
    branch: git.branch,
    clean: git.available ? git.changedFiles.length === 0 : null,
    last_seen: project.last_seen
  };
}

function requireRelayProjectId(root: string, envelope: RelayRequestEnvelope, allowedProjectIds?: string[]): string {
  return requireRelayProject(root, envelope, allowedProjectIds).id;
}

function requireRelayProject(root: string, envelope: RelayRequestEnvelope, allowedProjectIds?: string[]): { id: string; name: string; root: string; registered: boolean } {
  const projectId = validateProjectId(envelope.project_id ?? extractProjectId(envelope.path));
  const allowed = normalizeAllowedProjectIds(allowedProjectIds);
  if (allowed && !allowed.has(projectId.toLowerCase())) {
    throw new Error("Project is not registered for relay dispatch.");
  }
  const registered = listProjects(root);
  if (registered.length) {
    const project = findProject(root, projectId);
    if (!project) {
      throw new Error("Project is not registered for relay dispatch.");
    }
    return { id: project.id, name: project.name, root: project.root, registered: true };
  }
  if (projectId.toLowerCase() !== projectIdFromRoot(root).toLowerCase()) {
    throw new Error("Project is not registered for relay dispatch.");
  }
  return { id: projectIdFromRoot(root), name: projectIdFromRoot(root), root, registered: false };
}

function normalizeAllowedProjectIds(allowedProjectIds: string[] | undefined): Set<string> | undefined {
  if (!allowedProjectIds?.length) {
    return undefined;
  }
  return new Set(allowedProjectIds.map((id) => validateProjectId(id).toLowerCase()));
}

function extractProjectId(path: string): string {
  const match = /^\/chatgpt\/projects\/([^/]+)\//.exec(path);
  return match?.[1] ?? "";
}

function relayTimelineOptions(body: unknown): SessionTimelineOptions {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { mode: "recent", limit: 20 };
  }
  const record = body as Record<string, unknown>;
  const mode = typeof record.mode === "string" && ["recent", "handoff", "file", "task"].includes(record.mode) ? record.mode : "recent";
  const limit = typeof record.limit === "number" && Number.isInteger(record.limit) ? Math.max(1, Math.min(record.limit, 50)) : 20;
  return {
    mode: mode as SessionTimelineOptions["mode"],
    handoff_id: typeof record.handoff_id === "string" ? record.handoff_id : undefined,
    file_path: typeof record.file_path === "string" ? record.file_path : undefined,
    task_id: typeof record.task_id === "string" ? record.task_id : undefined,
    limit
  };
}

function relayPathForOperation(operationId: string, projectId: string): string | undefined {
  const sessionSuffix =
    operationId === "getSessionSummary"
      ? "summary"
      : operationId === "getSessionContext"
        ? "context"
        : operationId === "getSessionTimeline"
          ? "timeline"
          : undefined;
  if (sessionSuffix) {
    return `/chatgpt/projects/${projectId}/session/${sessionSuffix}`;
  }
  const suffixes: Record<string, string> = {
    inspectProject: "inspect",
    getCodexChanges: "codex-changes",
    getReviewPacket: "review-packet",
    getProjectTree: "tree",
    searchProjectFiles: "files/search",
    readProjectFile: "file",
    searchProjectText: "grep"
  };
  const suffix = suffixes[operationId];
  return suffix ? `/chatgpt/projects/${projectId}/${suffix}` : undefined;
}

function relayInspectorOptions(body: unknown): InspectorOptions {
  const record = relayBody(body);
  return {
    maxCharsPerField: numberField(record, "max_chars"),
    includeDiff: booleanField(record, "include_diff")
  };
}

function relayBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function booleanField(record: Record<string, unknown>, field: string): boolean | undefined {
  const value = record[field];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") {
      return true;
    }
    if (value.toLowerCase() === "false") {
      return false;
    }
  }
  return undefined;
}
