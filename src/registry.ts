import fs from "node:fs";
import path from "node:path";
import { ensureDir, readJsonIfExists, writeJson } from "./fsx.js";
import { getGitInfo } from "./git.js";
import { bridgePath, getBridgeDir, getProjectName, resolveProjectRoot } from "./paths.js";

export type ProjectRegistrySource = "manual" | "scan" | "current";
export type ProjectRegistryType = "git" | "folder" | "unknown";

export interface RegisteredProject {
  id: string;
  name: string;
  root: string;
  type: ProjectRegistryType;
  source: ProjectRegistrySource;
  created_at: string;
  updated_at: string;
  last_seen: string;
}

export interface ProjectRegistryFile {
  version: 1;
  projects: RegisteredProject[];
}

export const PROJECT_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

export function registryPath(registryRootInput = process.cwd()): string {
  return bridgePath(resolveProjectRoot(registryRootInput), "projects.json");
}

export function emptyRegistry(): ProjectRegistryFile {
  return {
    version: 1,
    projects: []
  };
}

export function readProjectRegistry(registryRootInput = process.cwd()): ProjectRegistryFile {
  const registry = readJsonIfExists<ProjectRegistryFile | RegisteredProject[]>(registryPath(registryRootInput));
  if (!registry) {
    return emptyRegistry();
  }

  if (Array.isArray(registry)) {
    return {
      version: 1,
      projects: registry.map((project) => normalizeLegacyProject(project))
    };
  }

  return {
    version: 1,
    projects: Array.isArray(registry.projects) ? registry.projects.map((project) => normalizeLegacyProject(project)) : []
  };
}

export function writeProjectRegistry(registryRootInput: string, registry: ProjectRegistryFile): void {
  const root = resolveProjectRoot(registryRootInput);
  ensureDir(getBridgeDir(root));
  writeJson(registryPath(root), {
    version: 1,
    projects: registry.projects.map((project) => ({
      id: project.id,
      name: project.name,
      root: project.root,
      type: project.type,
      source: project.source,
      created_at: project.created_at,
      updated_at: project.updated_at,
      last_seen: project.last_seen
    }))
  });
}

export function validateProjectId(idInput: string): string {
  const id = idInput.trim();
  if (!id) {
    throw new Error("Project id is required.");
  }
  if (!PROJECT_ID_PATTERN.test(id)) {
    throw new Error("Project id must match ^[A-Za-z0-9._-]{1,80}$.");
  }
  if (id.includes("..") || id.includes("/") || id.includes("\\") || id.includes(":") || /^[A-Za-z]:$/i.test(id)) {
    throw new Error("Project id must be a safe identifier, not a path.");
  }
  return id;
}

export function projectIdFromRoot(rootInput: string): string {
  const root = resolveProjectRoot(rootInput);
  const baseName = getProjectName(root);
  const id = baseName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  return validateProjectId(id.includes("..") ? id.replace(/\.+/g, ".").replace(/\.\./g, ".") : id);
}

export function validateProjectRoot(projectPathInput: string): string {
  const resolved = resolveProjectRoot(projectPathInput);
  const root = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  if (!fs.existsSync(root)) {
    throw new Error(`Project path does not exist: ${projectPathInput}`);
  }
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) {
    throw new Error(`Project path is not a directory: ${projectPathInput}`);
  }
  if (isDangerousRoot(root)) {
    throw new Error(`Refusing to register unsafe project root: ${root}`);
  }
  fs.accessSync(root, fs.constants.R_OK);
  return root;
}

export function detectProjectType(rootInput: string): ProjectRegistryType {
  const root = resolveProjectRoot(rootInput);
  if (fs.existsSync(path.join(root, ".git"))) {
    return "git";
  }
  return "folder";
}

export function registerProject(
  registryRootInput: string,
  idInput: string,
  projectPathInput: string,
  source: ProjectRegistrySource = "manual"
): RegisteredProject {
  const registryRoot = resolveProjectRoot(registryRootInput);
  const id = validateProjectId(idInput);
  const root = validateProjectRoot(projectPathInput);
  const now = new Date().toISOString();
  const registry = readProjectRegistry(registryRoot);
  const existing = registry.projects.find((project) => project.id.toLowerCase() === id.toLowerCase());
  const project: RegisteredProject = {
    id,
    name: getProjectName(root),
    root,
    type: detectProjectType(root),
    source,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    last_seen: now
  };

  const projects = registry.projects.filter((item) => item.id.toLowerCase() !== id.toLowerCase());
  projects.push(project);
  projects.sort((a, b) => a.id.localeCompare(b.id));
  writeProjectRegistry(registryRoot, { version: 1, projects });
  return project;
}

export function registerCurrentProject(registryRootInput = process.cwd(), idInput?: string): RegisteredProject {
  const root = resolveProjectRoot(registryRootInput);
  const id = idInput ? validateProjectId(idInput) : projectIdFromRoot(root);
  return registerProject(root, id, root, "current");
}

export function listProjects(registryRootInput = process.cwd()): RegisteredProject[] {
  return readProjectRegistry(registryRootInput).projects;
}

export function findProject(registryRootInput: string, idInput: string): RegisteredProject | undefined {
  const id = validateProjectId(idInput);
  return listProjects(registryRootInput).find((project) => project.id.toLowerCase() === id.toLowerCase());
}

export function removeProject(registryRootInput: string, idInput: string): boolean {
  const registryRoot = resolveProjectRoot(registryRootInput);
  const id = validateProjectId(idInput);
  const registry = readProjectRegistry(registryRoot);
  const projects = registry.projects.filter((project) => project.id.toLowerCase() !== id.toLowerCase());
  writeProjectRegistry(registryRoot, { version: 1, projects });
  return projects.length !== registry.projects.length;
}

export function touchProject(registryRootInput: string, idInput: string): RegisteredProject | undefined {
  const registryRoot = resolveProjectRoot(registryRootInput);
  const id = validateProjectId(idInput);
  const registry = readProjectRegistry(registryRoot);
  const project = registry.projects.find((item) => item.id.toLowerCase() === id.toLowerCase());
  if (!project) {
    return undefined;
  }

  project.last_seen = new Date().toISOString();
  writeProjectRegistry(registryRoot, registry);
  return project;
}

export function projectRootHint(rootInput: string): string {
  const root = resolveProjectRoot(rootInput);
  const parsed = path.parse(root);
  const name = path.basename(root) || root;
  return path.join(parsed.root, "...", name);
}

export function formatProjectList(projects: RegisteredProject[], registryRootInput = process.cwd()): string {
  if (!projects.length) {
    const fallbackRoot = resolveProjectRoot(registryRootInput);
    const fallbackGit = getGitInfo(fallbackRoot, "short");
    return [
      "Registered projects:",
      "",
      "None",
      "",
      "Current-project fallback is active.",
      `Fallback ID: ${projectIdFromRoot(fallbackRoot)}`,
      `Fallback root: ${projectRootHint(fallbackRoot)}`,
      `Git available: ${fallbackGit.available ? "yes" : "no"}`,
      `Branch: ${fallbackGit.branch}`,
      `Status: ${fallbackGit.available && fallbackGit.changedFiles.length === 0 ? "clean" : "dirty"}`
    ].join("\n");
  }

  const lines = ["Registered projects:", "", "ID            Git  Branch          Status  Type     Source   Last seen                 Root"];
  for (const project of projects) {
    const git = getGitInfo(project.root, "short");
    const status = git.available && git.changedFiles.length === 0 ? "clean" : "dirty";
    lines.push(
      [
        project.id.padEnd(13),
        (git.available ? "yes" : "no").padEnd(4),
        git.branch.padEnd(15),
        status.padEnd(7),
        project.type.padEnd(8),
        project.source.padEnd(8),
        project.last_seen.padEnd(25),
        projectRootHint(project.root)
      ].join(" ")
    );
  }
  return lines.join("\n");
}

// Backward-compatible alias for the older plural project command.
export function addProject(projectPathInput = process.cwd(), registryRootInput = process.cwd()): RegisteredProject {
  const root = validateProjectRoot(projectPathInput);
  return registerProject(registryRootInput, projectIdFromRoot(root), root, "manual");
}

function normalizeLegacyProject(input: unknown): RegisteredProject {
  const project = isRecord(input) ? input : {};
  const root = String(project.root ?? project.project_root ?? "");
  const id = String(project.id ?? project.project_name ?? (root ? getProjectName(root) : "project"));
  const now = new Date().toISOString();
  return {
    id: validateProjectId(id),
    name: String(project.name ?? project.project_name ?? getProjectName(root)),
    root: resolveProjectRoot(root),
    type: isProjectRegistryType(project.type) ? project.type : detectProjectType(root),
    source: isProjectRegistrySource(project.source) ? project.source : "manual",
    created_at: typeof project.created_at === "string" ? project.created_at : now,
    updated_at: typeof project.updated_at === "string" ? project.updated_at : now,
    last_seen: typeof project.last_seen === "string" ? project.last_seen : typeof project.last_seen_at === "string" ? project.last_seen_at : now
  };
}

function isProjectRegistryType(value: unknown): value is ProjectRegistryType {
  return value === "git" || value === "folder" || value === "unknown";
}

function isProjectRegistrySource(value: unknown): value is ProjectRegistrySource {
  return value === "manual" || value === "scan" || value === "current";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDangerousRoot(root: string): boolean {
  const parsed = path.parse(root);
  if (root.toLowerCase() === parsed.root.toLowerCase()) {
    return true;
  }

  const lower = root.toLowerCase();
  const systemRoots = [
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"]
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value).toLowerCase());

  if (systemRoots.some((systemRoot) => lower === systemRoot || lower.startsWith(`${systemRoot}${path.sep}`))) {
    return true;
  }

  const appDataRoots = [process.env.APPDATA, process.env.LOCALAPPDATA]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value).toLowerCase());
  return appDataRoots.some((appDataRoot) => lower === appDataRoot);
}
