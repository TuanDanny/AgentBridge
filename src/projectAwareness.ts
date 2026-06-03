export type ScaleHint = "small" | "medium" | "large" | "extreme";
export type CandidatePriority = "high" | "medium" | "low";
export type CoverageWarningLevel = "partial" | "medium" | "large" | "extreme";

export interface AwarenessTreeEntry {
  path: string;
  type: "file" | "directory";
  size?: number;
}

export interface ProjectInventory {
  complete: boolean;
  scale_hint: ScaleHint;
  total_files_seen: number;
  total_dirs_seen: number;
  total_entries_seen: number;
  tree_truncated: boolean;
  max_depth_used: number;
  max_entries_used: number;
  bytes_estimate: number;
}

export interface ProjectClassification {
  source_dirs: string[];
  test_dirs: string[];
  docs_dirs: string[];
  config_files: string[];
  script_dirs: string[];
  generated_dirs: string[];
  vendor_dirs: string[];
  tooling_dirs: string[];
}

export interface ImportantCandidate {
  path: string;
  reason: string;
  priority: CandidatePriority;
}

export interface RecommendedRead {
  path: string;
  why: string;
}

export interface SuspiciousRootFile {
  path: string;
  reason: string;
}

export interface CoverageWarning {
  level: CoverageWarningLevel;
  message: string;
}

const SOURCE_DIRS = new Set(["src", "lib", "app", "apps", "packages", "server", "client", "backend", "frontend", "core"]);
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e"]);
const DOCS_DIRS = new Set(["docs", "doc", "documentation", "design", "architecture"]);
const SCRIPT_DIRS = new Set(["scripts", "script", "bin", "tools"]);
const GENERATED_DIRS = new Set(["dist", "build", "out", "coverage", "outputs", "runs", ".next", "target", "bin", "obj"]);
const VENDOR_DIRS = new Set(["node_modules", "vendor", "third_party", "external", "template", "templates"]);
const TOOLING_DIRS = new Set([".github", ".vscode", ".idea", ".agentbridge", ".codex", ".husky", ".git"]);
const CONFIG_FILES = new Set([
  "README.md",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "vitest.config.ts",
  "vite.config.ts",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "Dockerfile",
  ".gitignore"
]);

const IMPORTANT_FILE_NAMES = new Map<string, { reason: string; priority: CandidatePriority }>([
  ["README.md", { reason: "repo overview", priority: "high" }],
  ["ARCHITECTURE.md", { reason: "architecture overview", priority: "high" }],
  ["AI_CONTEXT.md", { reason: "project context", priority: "high" }],
  ["AGENTS.md", { reason: "agent instructions", priority: "high" }],
  ["GUIDE.md", { reason: "usage guide", priority: "medium" }],
  ["DEMO.md", { reason: "demo workflow", priority: "medium" }],
  ["package.json", { reason: "project config and scripts", priority: "high" }],
  ["tsconfig.json", { reason: "TypeScript config", priority: "medium" }],
  ["vitest.config.ts", { reason: "test configuration", priority: "medium" }]
]);

const IMPORTANT_CANDIDATE_CAP = 80;
const RECOMMENDED_NEXT_READS_CAP = 25;
const SUSPICIOUS_ROOT_FILES_CAP = 20;

export function estimateScale(stats: { totalFiles: number; totalDirs: number; totalEntries: number }): ScaleHint {
  const total = Math.max(stats.totalFiles, stats.totalEntries - stats.totalDirs);
  if (total <= 1000) {
    return "small";
  }
  if (total <= 20000) {
    return "medium";
  }
  if (total <= 200000) {
    return "large";
  }
  return "extreme";
}

export function buildInventory(args: {
  totalFiles: number;
  totalDirs: number;
  treeTruncated: boolean;
  maxDepth: number;
  maxEntries: number;
  bytesEstimate: number;
}): ProjectInventory {
  const totalEntries = args.totalFiles + args.totalDirs;
  const scaleHint = estimateScale({
    totalFiles: args.totalFiles,
    totalDirs: args.totalDirs,
    totalEntries
  });

  return {
    complete: !args.treeTruncated && scaleHint !== "large" && scaleHint !== "extreme",
    scale_hint: scaleHint,
    total_files_seen: args.totalFiles,
    total_dirs_seen: args.totalDirs,
    total_entries_seen: totalEntries,
    tree_truncated: args.treeTruncated,
    max_depth_used: args.maxDepth,
    max_entries_used: args.maxEntries,
    bytes_estimate: args.bytesEstimate
  };
}

export function classifyTopLevelEntries(entries: AwarenessTreeEntry[], skippedTopLevelDirs: string[] = []): ProjectClassification {
  const classification: ProjectClassification = {
    source_dirs: [],
    test_dirs: [],
    docs_dirs: [],
    config_files: [],
    script_dirs: [],
    generated_dirs: [],
    vendor_dirs: [],
    tooling_dirs: []
  };

  for (const entry of entries) {
    if (entry.path.includes("/")) {
      continue;
    }
    addClassificationEntry(classification, entry.path, entry.type);
  }

  for (const dir of skippedTopLevelDirs) {
    if (!dir.includes("/")) {
      addClassificationEntry(classification, dir, "directory");
    }
  }

  return {
    source_dirs: uniqueSorted(classification.source_dirs),
    test_dirs: uniqueSorted(classification.test_dirs),
    docs_dirs: uniqueSorted(classification.docs_dirs),
    config_files: uniqueSorted(classification.config_files),
    script_dirs: uniqueSorted(classification.script_dirs),
    generated_dirs: uniqueSorted(classification.generated_dirs),
    vendor_dirs: uniqueSorted(classification.vendor_dirs),
    tooling_dirs: uniqueSorted(classification.tooling_dirs)
  };
}

export function findImportantCandidates(
  entries: AwarenessTreeEntry[],
  classification: ProjectClassification,
  changedPaths: string[] = []
): ImportantCandidate[] {
  const candidates = new Map<string, ImportantCandidate>();
  const changed = new Set(changedPaths);

  for (const entry of entries) {
    if (entry.type !== "file" || isNoisePath(entry.path)) {
      continue;
    }

    const baseName = basename(entry.path);
    const importantByName = IMPORTANT_FILE_NAMES.get(baseName);
    if (importantByName) {
      addCandidate(candidates, entry.path, importantByName.reason, importantByName.priority);
      continue;
    }

    if (changed.has(entry.path)) {
      addCandidate(candidates, entry.path, "changed file", "high");
      continue;
    }

    const first = firstSegment(entry.path);
    if (classification.source_dirs.includes(first) && isLikelySourceFile(entry.path)) {
      addCandidate(candidates, entry.path, "source file candidate", "high");
      continue;
    }
    if (classification.test_dirs.includes(first) && isLikelyTestFile(entry.path)) {
      addCandidate(candidates, entry.path, "test file candidate", "medium");
      continue;
    }
    if (classification.docs_dirs.includes(first) && isMarkdown(entry.path)) {
      addCandidate(candidates, entry.path, "documentation candidate", "medium");
    }
  }

  return [...candidates.values()].sort(compareCandidates).slice(0, IMPORTANT_CANDIDATE_CAP);
}

export function findRecommendedNextReads(candidates: ImportantCandidate[]): RecommendedRead[] {
  return candidates
    .filter((candidate) => candidate.priority !== "low")
    .slice(0, RECOMMENDED_NEXT_READS_CAP)
    .map((candidate) => ({
      path: candidate.path,
      why: candidate.reason
    }));
}

export function detectSuspiciousRootFiles(entries: AwarenessTreeEntry[]): SuspiciousRootFile[] {
  const suspicious: SuspiciousRootFile[] = [];
  for (const entry of entries) {
    if (entry.type !== "file" || entry.path.includes("/")) {
      continue;
    }
    const name = entry.path;
    if (
      /^tatus --short$/i.test(name) ||
      /^git status/i.test(name) ||
      /^npm test/i.test(name) ||
      /^pytest -q$/i.test(name) ||
      /^pnpm test/i.test(name) ||
      /^cmd output/i.test(name) ||
      /\.tmp$/i.test(name) ||
      /\.bak$/i.test(name) ||
      /^debug\.log$/i.test(name)
    ) {
      suspicious.push({
        path: name,
        reason: "Looks like accidental command-output or temporary filename."
      });
    }
    if (suspicious.length >= SUSPICIOUS_ROOT_FILES_CAP) {
      break;
    }
  }
  return suspicious;
}

export function buildCoverageWarning(args: {
  inventoryComplete: boolean;
  treeTruncated: boolean;
  scaleHint: ScaleHint;
}): CoverageWarning | null {
  if (args.scaleHint === "extreme") {
    return {
      level: "extreme",
      message: "Repository scale is extreme for v0.5.1. Do not claim complete repository awareness."
    };
  }
  if (args.scaleHint === "large") {
    return {
      level: "large",
      message: "Repository scale is large for v0.5.1. Use compact inventory and do not claim complete repository awareness."
    };
  }
  if (args.treeTruncated || !args.inventoryComplete) {
    return {
      level: "partial",
      message: "Tree was truncated or depth-limited. Do not claim complete repository awareness."
    };
  }
  return null;
}

export function recommendedNextAction(args: {
  coverageWarning: CoverageWarning | null;
  recommendedReads: RecommendedRead[];
}): string | null {
  if (args.coverageWarning) {
    return "Treat repository awareness as partial. Read recommended files and avoid strong conclusions until coverage improves.";
  }
  if (args.recommendedReads.length) {
    return "Read recommended_next_reads before making strong technical conclusions.";
  }
  return null;
}

function addClassificationEntry(classification: ProjectClassification, name: string, type: AwarenessTreeEntry["type"]): void {
  const normalized = name.toLowerCase();
  if (type === "directory") {
    if (matchesDirRole(normalized, SOURCE_DIRS)) {
      classification.source_dirs.push(name);
    }
    if (matchesDirRole(normalized, TEST_DIRS)) {
      classification.test_dirs.push(name);
    }
    if (matchesDirRole(normalized, DOCS_DIRS)) {
      classification.docs_dirs.push(name);
    }
    if (matchesDirRole(normalized, SCRIPT_DIRS)) {
      classification.script_dirs.push(name);
    }
    if (matchesDirRole(normalized, GENERATED_DIRS)) {
      classification.generated_dirs.push(name);
    }
    if (matchesDirRole(normalized, VENDOR_DIRS)) {
      classification.vendor_dirs.push(name);
    }
    if (matchesDirRole(normalized, TOOLING_DIRS)) {
      classification.tooling_dirs.push(name);
    }
    return;
  }

  if (CONFIG_FILES.has(name) || CONFIG_FILES.has(normalized)) {
    classification.config_files.push(name);
  }
}

function addCandidate(
  candidates: Map<string, ImportantCandidate>,
  candidatePath: string,
  reason: string,
  priority: CandidatePriority
): void {
  const existing = candidates.get(candidatePath);
  if (!existing || priorityRank(priority) < priorityRank(existing.priority)) {
    candidates.set(candidatePath, {
      path: candidatePath,
      reason,
      priority
    });
  }
}

function compareCandidates(a: ImportantCandidate, b: ImportantCandidate): number {
  const rank = priorityRank(a.priority) - priorityRank(b.priority);
  if (rank !== 0) {
    return rank;
  }
  return a.path.localeCompare(b.path);
}

function priorityRank(priority: CandidatePriority): number {
  return { high: 0, medium: 1, low: 2 }[priority];
}

function matchesDirRole(normalizedName: string, knownDirs: Set<string>): boolean {
  if (knownDirs.has(normalizedName)) {
    return true;
  }
  return [...knownDirs].some((known) => normalizedName.startsWith(`${known}_`) || normalizedName.startsWith(`${known}-`));
}

function firstSegment(entryPath: string): string {
  return entryPath.split("/")[0] ?? entryPath;
}

function basename(entryPath: string): string {
  const segments = entryPath.split("/");
  return segments[segments.length - 1] ?? entryPath;
}

function isMarkdown(entryPath: string): boolean {
  return /\.mdx?$/i.test(entryPath);
}

function isLikelySourceFile(entryPath: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs|rb|php|swift|kt|cpp|c|h)$/i.test(entryPath);
}

function isLikelyTestFile(entryPath: string): boolean {
  return /(?:^|[./_-])(test|spec)(?:[./_-]|$)/i.test(entryPath) || /\.(test|spec)\.[A-Za-z0-9]+$/i.test(entryPath);
}

function isNoisePath(entryPath: string): boolean {
  const first = firstSegment(entryPath).toLowerCase();
  return GENERATED_DIRS.has(first) || VENDOR_DIRS.has(first) || TOOLING_DIRS.has(first);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
