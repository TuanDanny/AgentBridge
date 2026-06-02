import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getGitInfo } from "./git.js";
import { getProjectName, resolveProjectRoot } from "./paths.js";
import { PROJECT_ID_PATTERN, projectRootHint } from "./registry.js";

export type ProjectNameStyle = "folder" | "package" | "git";

export interface DiscoverProjectsOptions {
  maxDepth?: number;
  maxProjects?: number;
  includeNonGit?: boolean;
  nameStyle?: ProjectNameStyle;
}

export interface NormalizedDiscoverProjectsOptions {
  maxDepth: number;
  maxProjects: number;
  includeNonGit: boolean;
  nameStyle: ProjectNameStyle;
}

export interface ProjectCandidate {
  id: string;
  name: string;
  root: string;
  root_hint: string;
  markers: string[];
  git_available: boolean;
  branch?: string;
  clean?: boolean;
  package_name?: string;
  source: "scan";
}

export interface ProjectScanResult {
  ok: true;
  root: string;
  mode: "preview" | "register";
  max_depth: number;
  max_projects: number;
  candidates: ProjectCandidate[];
  registered: unknown[];
}

export const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "settings.gradle",
  "tsconfig.json",
  "vite.config.ts",
  "next.config.js",
  "angular.json",
  "composer.json",
  "Gemfile",
  "CMakeLists.txt",
  "Makefile"
];

export const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".agentbridge",
  "dist",
  "build",
  "out",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".turbo",
  ".cache",
  ".idea",
  ".vscode",
  "coverage",
  "vendor",
  "bin",
  "obj"
]);

const SCAN_ROOT_ERROR = "Refusing to scan broad/system root. Please choose a specific projects folder.";

export function normalizeDiscoverOptions(options: DiscoverProjectsOptions = {}): NormalizedDiscoverProjectsOptions {
  const maxDepth = options.maxDepth ?? 4;
  const maxProjects = options.maxProjects ?? 50;
  const nameStyle = options.nameStyle ?? "folder";

  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 20) {
    throw new Error("max-depth must be an integer from 0 to 20.");
  }
  if (!Number.isInteger(maxProjects) || maxProjects < 1 || maxProjects > 500) {
    throw new Error("max-projects must be an integer from 1 to 500.");
  }
  if (!["folder", "package", "git"].includes(nameStyle)) {
    throw new Error("name-style must be folder, package, or git.");
  }

  return {
    maxDepth,
    maxProjects,
    includeNonGit: options.includeNonGit ?? true,
    nameStyle
  };
}

export function validateScanRoot(rootInput: string): string {
  const resolved = resolveProjectRoot(rootInput);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Scan root does not exist: ${rootInput}`);
  }

  const root = fs.realpathSync(resolved);
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) {
    throw new Error(`Scan root is not a directory: ${rootInput}`);
  }
  if (isBroadOrSystemRoot(root)) {
    throw new Error(SCAN_ROOT_ERROR);
  }
  fs.accessSync(root, fs.constants.R_OK);
  return root;
}

export function isIgnoredDirectory(name: string): boolean {
  return IGNORED_DIRECTORIES.has(name);
}

export function findProjectMarkers(dir: string): string[] {
  return PROJECT_MARKERS.filter((marker) => fs.existsSync(path.join(dir, marker)));
}

export function makeSafeProjectId(nameInput: string, existingIds = new Set<string>()): string {
  const existing = new Set([...existingIds].map((id) => id.toLowerCase()));
  let base = nameInput
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "");

  if (!base || base.includes("..")) {
    base = "project";
  }

  base = trimProjectId(base);
  let candidate = base;
  let suffix = 2;
  while (!PROJECT_ID_PATTERN.test(candidate) || candidate.includes("..") || existing.has(candidate.toLowerCase())) {
    const suffixText = `-${suffix}`;
    candidate = `${trimProjectId(base, 80 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  existingIds.add(candidate);
  return candidate;
}

export function discoverProjects(rootInput: string, options: DiscoverProjectsOptions = {}): ProjectCandidate[] {
  const root = validateScanRoot(rootInput);
  const normalized = normalizeDiscoverOptions(options);
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const visited = new Set<string>();
  const usedIds = new Set<string>();
  const candidates: ProjectCandidate[] = [];

  while (queue.length && candidates.length < normalized.maxProjects) {
    const current = queue.shift();
    if (!current) {
      break;
    }

    let dir: string;
    try {
      dir = fs.realpathSync(current.dir);
    } catch {
      continue;
    }
    if (visited.has(dir)) {
      continue;
    }
    visited.add(dir);

    if (dir !== root && isIgnoredDirectory(path.basename(dir))) {
      continue;
    }

    const markers = findProjectMarkers(dir);
    if (markers.length) {
      const git = getGitInfo(dir, "short");
      if (normalized.includeNonGit || git.available) {
        const packageName = readPackageName(dir);
        const name = inferCandidateName(dir, packageName, normalized.nameStyle);
        candidates.push({
          id: makeSafeProjectId(name, usedIds),
          name,
          root: dir,
          root_hint: projectRootHint(dir),
          markers,
          git_available: git.available,
          ...(git.available
            ? {
                branch: git.branch,
                clean: git.changedFiles.length === 0
              }
            : {}),
          ...(packageName ? { package_name: packageName } : {}),
          source: "scan"
        });
      }
    }

    if (current.depth >= normalized.maxDepth) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || isIgnoredDirectory(entry.name)) {
        continue;
      }
      queue.push({ dir: path.join(dir, entry.name), depth: current.depth + 1 });
    }
  }

  return candidates;
}

export function parseScanSelection(selection: string, candidateCount: number): number[] {
  const parts = selection.split(",").map((part) => part.trim());
  if (!parts.length) {
    throw new Error("--select must include one or more 1-based indexes.");
  }

  const selected = new Set<number>();
  for (const part of parts) {
    if (!part) {
      throw new Error("--select must not contain empty indexes.");
    }
    if (!/^\d+$/.test(part)) {
      throw new Error(`Invalid --select index "${part}". Use values from 1 to ${candidateCount}.`);
    }
    const index = Number.parseInt(part, 10);
    if (index < 1 || index > candidateCount) {
      throw new Error(`Invalid --select index "${part}". Use values from 1 to ${candidateCount}.`);
    }
    selected.add(index - 1);
  }
  return [...selected];
}

export function formatProjectScanResult(result: ProjectScanResult): string {
  const lines = [`Found ${result.candidates.length} candidate projects under ${result.root}`, ""];
  if (!result.candidates.length) {
    lines.push("No candidate projects found with strong project markers.");
  }

  result.candidates.forEach((candidate, index) => {
    lines.push(`[${index + 1}] ${candidate.id}`);
    lines.push(`    Root: ${candidate.root_hint}`);
    lines.push(`    Markers: ${candidate.markers.join(", ")}`);
    lines.push(`    Git: ${formatGitSummary(candidate)}`);
    if (candidate.package_name) {
      lines.push(`    Package: ${candidate.package_name}`);
    }
    lines.push("");
  });

  if (result.mode === "register") {
    lines.push(`Registered ${result.registered.length} project(s).`);
    return lines.join("\n").trimEnd();
  }

  lines.push("Next:");
  lines.push(`- Register all: agentbridge project scan ${result.root} --register`);
  lines.push(`- Register selected: agentbridge project scan ${result.root} --register --select 1,3`);
  return lines.join("\n");
}

function inferCandidateName(root: string, packageName: string | undefined, nameStyle: ProjectNameStyle): string {
  if (nameStyle === "package" && packageName) {
    return packageName;
  }
  return getProjectName(root);
}

function readPackageName(root: string): string | undefined {
  const packagePath = path.join(root, "package.json");
  if (!fs.existsSync(packagePath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : undefined;
  } catch {
    return undefined;
  }
}

function formatGitSummary(candidate: ProjectCandidate): string {
  if (!candidate.git_available) {
    return "unavailable";
  }
  return `${candidate.branch ?? "unknown"}, ${candidate.clean ? "clean" : "dirty"}`;
}

function trimProjectId(id: string, maxLength = 80): string {
  const trimmed = id.slice(0, maxLength).replace(/[-.]+$/g, "");
  return trimmed || "project";
}

function isBroadOrSystemRoot(root: string): boolean {
  const parsed = path.parse(root);
  const lower = normalizePath(root);
  if (lower === normalizePath(parsed.root)) {
    return true;
  }

  const usersRoot = path.join(parsed.root, "Users");
  if (lower === normalizePath(usersRoot) || lower === normalizePath("/Users") || lower === normalizePath("/home")) {
    return true;
  }

  const home = os.homedir();
  if (home && lower === normalizePath(home)) {
    return true;
  }

  const systemRoot = process.env.SystemRoot;
  const systemRoots = [
    systemRoot,
    systemRoot ? path.join(systemRoot, "System32") : undefined,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"]
  ].filter((value): value is string => Boolean(value));
  if (systemRoots.some((systemPath) => isSameOrInside(lower, normalizePath(systemPath)))) {
    return true;
  }

  const appDataRoots = [process.env.APPDATA, process.env.LOCALAPPDATA].filter((value): value is string => Boolean(value));
  return appDataRoots.some((appDataRoot) => lower === normalizePath(appDataRoot));
}

function normalizePath(input: string): string {
  return path.resolve(input).replace(/[\\/]+$/g, "").toLowerCase();
}

function isSameOrInside(normalizedPath: string, normalizedRoot: string): boolean {
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot.toLowerCase()}${path.sep.toLowerCase()}`);
}
