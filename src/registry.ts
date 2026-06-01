import os from "node:os";
import path from "node:path";
import { ensureDir, readJsonIfExists, writeJson } from "./fsx.js";
import { getBridgeDir, getProjectName, resolveProjectRoot } from "./paths.js";
import { readSession } from "./session.js";

export interface RegisteredProject {
  project_root: string;
  project_name: string;
  bridge_dir: string;
  session_id: string;
  status: string;
  next_action: string;
  last_seen_at: string;
}

export function getAgentBridgeHome(): string {
  if (process.env.AGENTBRIDGE_HOME) {
    return path.resolve(process.env.AGENTBRIDGE_HOME);
  }

  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "AgentBridge");
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "AgentBridge");
  }

  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "agentbridge");
}

export function registryPath(): string {
  return path.join(getAgentBridgeHome(), "projects.json");
}

export function listProjects(): RegisteredProject[] {
  return readJsonIfExists<RegisteredProject[]>(registryPath()) ?? [];
}

export function addProject(rootInput = process.cwd()): RegisteredProject {
  const root = resolveProjectRoot(rootInput);
  const session = readSession(root);
  const project: RegisteredProject = {
    project_root: root,
    project_name: session.project_name || getProjectName(root),
    bridge_dir: getBridgeDir(root),
    session_id: session.session_id,
    status: session.status,
    next_action: session.next_action,
    last_seen_at: new Date().toISOString()
  };

  const projects = listProjects().filter((item) => item.project_root.toLowerCase() !== root.toLowerCase());
  projects.push(project);
  projects.sort((a, b) => a.project_name.localeCompare(b.project_name));
  ensureDir(getAgentBridgeHome());
  writeJson(registryPath(), projects);
  return project;
}

export function removeProject(rootInput: string): boolean {
  const root = resolveProjectRoot(rootInput);
  const before = listProjects();
  const after = before.filter((item) => item.project_root.toLowerCase() !== root.toLowerCase());
  ensureDir(getAgentBridgeHome());
  writeJson(registryPath(), after);
  return before.length !== after.length;
}
