import { getGitInfo } from "./git.js";
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

export function dispatchRelayRequestLocally(root = process.cwd(), envelope: RelayRequestEnvelope): RelayLocalDispatchResult {
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
        return ok(envelope.operation_id, listRelayProjects(root), baseMetadata);
      case "getSessionSummary":
        return ok(envelope.operation_id, getSessionSummary(root, requireRelayProjectId(root, envelope)), baseMetadata);
      case "getSessionContext":
        return ok(envelope.operation_id, getSessionCompactContext(root, requireRelayProjectId(root, envelope)), baseMetadata);
      case "getSessionTimeline":
        return ok(
          envelope.operation_id,
          getSessionTimeline(root, requireRelayProjectId(root, envelope), relayTimelineOptions(envelope.body)),
          baseMetadata
        );
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
  const suffix =
    operationId === "getSessionSummary"
      ? "summary"
      : operationId === "getSessionContext"
        ? "context"
        : operationId === "getSessionTimeline"
          ? "timeline"
          : "";
  if (!suffix) {
    throw new Error("Unsupported relay operation.");
  }
  return {
    operation_id: operationId,
    method: "GET",
    path: `/chatgpt/projects/${safeProjectId}/session/${suffix}`,
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

function listRelayProjects(root: string): { mode: "registry" | "current_project_fallback"; projects: unknown[] } {
  const registered = listProjects(root);
  if (registered.length) {
    return {
      mode: "registry",
      projects: registered.map((project) => relayProjectSummary(project, true))
    };
  }
  const fallbackId = projectIdFromRoot(root);
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

function requireRelayProjectId(root: string, envelope: RelayRequestEnvelope): string {
  const projectId = validateProjectId(envelope.project_id ?? extractProjectId(envelope.path));
  const registered = listProjects(root);
  if (registered.length && !findProject(root, projectId)) {
    throw new Error("Project is not registered for relay dispatch.");
  }
  if (!registered.length && projectId.toLowerCase() !== projectIdFromRoot(root).toLowerCase()) {
    throw new Error("Project is not registered for relay dispatch.");
  }
  return projectId;
}

function extractProjectId(path: string): string {
  const match = /^\/chatgpt\/projects\/([^/]+)\/session\//.exec(path);
  return match?.[1] ?? "";
}

function relayTimelineOptions(body: unknown): SessionTimelineOptions {
  if (!body || typeof body !== "object") {
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
