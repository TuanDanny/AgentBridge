import fs from "node:fs";
import { bridgePath, getBridgeDir, resolveProjectRoot } from "./paths.js";
import { findProject, projectRootHint, validateProjectId } from "./registry.js";
import { appendJsonLine, ensureDir, readJsonIfExists, writeJson } from "./fsx.js";

export interface ActiveProjectFile {
  project_id: string;
  selected_at: string;
  selected_by: "chatgpt_action" | "cli";
}

export interface ActiveProjectView {
  id: string;
  selected_at: string;
  root_hint: string;
}

export interface ActiveProjectResponse {
  ok: true;
  active_project: ActiveProjectView | null;
  next_action?: string;
}

export interface ActiveProjectEvent {
  event: "select_project";
  project_id: string;
  previous_project_id: string | null;
  selected_at: string;
  selected_by: "chatgpt_action" | "cli";
  root_hint: string;
}

export function activeProjectPath(rootInput = process.cwd()): string {
  return bridgePath(resolveProjectRoot(rootInput), "active_project.json");
}

export function activeProjectEventsPath(rootInput = process.cwd()): string {
  return bridgePath(resolveProjectRoot(rootInput), "active_project_events.jsonl");
}

export function readActiveProject(rootInput = process.cwd()): ActiveProjectResponse {
  const root = resolveProjectRoot(rootInput);
  const active = readJsonIfExists<ActiveProjectFile>(activeProjectPath(root));
  if (!active?.project_id) {
    return { ok: true, active_project: null, next_action: "listProjects" };
  }

  let projectId: string;
  try {
    projectId = validateProjectId(active.project_id);
  } catch {
    return { ok: true, active_project: null, next_action: "listProjects" };
  }

  const project = findProject(root, projectId);
  if (!project) {
    return { ok: true, active_project: null, next_action: "listProjects" };
  }

  return {
    ok: true,
    active_project: {
      id: project.id,
      selected_at: active.selected_at,
      root_hint: projectRootHint(project.root)
    }
  };
}

export function selectActiveProject(rootInput: string, projectIdInput: string, selectedBy: "chatgpt_action" | "cli" = "cli"): ActiveProjectResponse {
  const root = resolveProjectRoot(rootInput);
  const projectId = validateProjectId(projectIdInput);
  const project = findProject(root, projectId);
  if (!project) {
    throw new Error("Project is not registered.");
  }

  const previous = readJsonIfExists<ActiveProjectFile>(activeProjectPath(root));
  let previousProjectId: string | null = null;
  if (previous?.project_id) {
    try {
      previousProjectId = validateProjectId(previous.project_id);
    } catch {
      previousProjectId = null;
    }
  }

  const selectedAt = new Date().toISOString();
  const rootHint = projectRootHint(project.root);
  ensureDir(getBridgeDir(root));
  writeJson(activeProjectPath(root), {
    project_id: project.id,
    selected_at: selectedAt,
    selected_by: selectedBy
  });
  appendJsonLine(activeProjectEventsPath(root), {
    event: "select_project",
    project_id: project.id,
    previous_project_id: previousProjectId,
    selected_at: selectedAt,
    selected_by: selectedBy,
    root_hint: rootHint
  } satisfies ActiveProjectEvent);

  return {
    ok: true,
    active_project: {
      id: project.id,
      selected_at: selectedAt,
      root_hint: rootHint
    }
  };
}

export function clearActiveProject(rootInput = process.cwd()): { ok: true; cleared: boolean } {
  const filePath = activeProjectPath(rootInput);
  const existed = fs.existsSync(filePath);
  fs.rmSync(filePath, { force: true });
  return { ok: true, cleared: existed };
}
