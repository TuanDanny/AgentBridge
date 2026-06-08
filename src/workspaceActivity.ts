import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { projectRootHint } from "./registry.js";
import { appendSessionActivity, getSessionSummary } from "./sessionStore.js";
import type { SharedSessionActivity, SharedSessionSummaryFile } from "./sessionTypes.js";

export interface WorkspaceChangedFile {
  path: string;
  status: string;
  bytes?: number;
  added_lines?: number | null;
  removed_lines?: number | null;
  binary?: boolean;
  large_diff_truncated?: boolean;
}

export interface WorkspaceSnapshot {
  ok: true;
  project_id: string;
  root_hint: string;
  git_available: boolean;
  branch: string;
  clean: boolean;
  changed_count: number;
  staged_count: number;
  unstaged_count: number;
  untracked_count: number;
  changed_files: WorkspaceChangedFile[];
  changed_files_truncated: boolean;
  raw_diff_stored: false;
  warning?: string;
}

export interface WorkspaceReconcileResult {
  ok: true;
  project_id: string;
  snapshot: WorkspaceSnapshot;
  activity_paths: string[];
  unlogged_changes: WorkspaceChangedFile[];
  activities_written: SharedSessionActivity[];
  status: "pass" | "warn";
}

export interface FileVerifyResult {
  ok: true;
  project_id: string;
  path: string;
  bytes: number;
  line_count: number;
  sha256: string;
  expected_sha256?: string;
  verified: boolean | null;
  activity: SharedSessionActivity;
  summary: SharedSessionSummaryFile;
  revision: number;
}

export class WorkspaceActivityError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkspaceActivityError";
    this.code = code;
  }
}

const MAX_CHANGED_FILES = 50;
const MAX_DIFF_FILES = 40;
const MAX_VERIFY_BYTES = 1024 * 1024;
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const PRIVATE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx"]);
const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".bmp",
  ".class",
  ".dll",
  ".exe",
  ".gif",
  ".ico",
  ".jar",
  ".jpg",
  ".jpeg",
  ".mov",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".so",
  ".webp",
  ".zip"
]);

export function createWorkspaceSnapshot(projectRoot: string, projectId: string): WorkspaceSnapshot {
  const branch = git(projectRoot, ["branch", "--show-current"]);
  const status = git(projectRoot, ["status", "--short"]);
  if (!status.ok) {
    return {
      ok: true,
      project_id: projectId,
      root_hint: projectRootHint(projectRoot),
      git_available: false,
      branch: "",
      clean: true,
      changed_count: 0,
      staged_count: 0,
      unstaged_count: 0,
      untracked_count: 0,
      changed_files: [],
      changed_files_truncated: false,
      raw_diff_stored: false,
      warning: "Git status unavailable. Workspace snapshot is metadata-only and incomplete."
    };
  }

  const parsed = parseGitStatus(status.stdout);
  const diffStats = readDiffStats(projectRoot, parsed.files.map((file) => file.path));
  const files = parsed.files.slice(0, MAX_CHANGED_FILES).map((file) => {
    const absolutePath = path.join(projectRoot, file.path);
    const stat = safeStat(absolutePath);
    const diff = diffStats.get(file.path);
    return {
      path: file.path,
      status: file.status,
      ...(stat?.isFile() ? { bytes: stat.size } : {}),
      ...(diff
        ? {
            added_lines: diff.added_lines,
            removed_lines: diff.removed_lines,
            binary: diff.binary,
            large_diff_truncated: diff.large_diff_truncated
          }
        : {})
    };
  });

  return {
    ok: true,
    project_id: projectId,
    root_hint: projectRootHint(projectRoot),
    git_available: true,
    branch: branch.ok ? branch.stdout.trim() : "",
    clean: parsed.files.length === 0,
    changed_count: parsed.files.length,
    staged_count: parsed.staged_count,
    unstaged_count: parsed.unstaged_count,
    untracked_count: parsed.untracked_count,
    changed_files: files,
    changed_files_truncated: parsed.files.length > MAX_CHANGED_FILES,
    raw_diff_stored: false,
    ...(parsed.files.length > MAX_CHANGED_FILES ? { warning: "Changed file list was capped." } : {})
  };
}

export function reconcileWorkspaceActivity(
  registryRoot: string,
  projectRoot: string,
  projectId: string
): WorkspaceReconcileResult {
  const snapshot = createWorkspaceSnapshot(projectRoot, projectId);
  const summaryBefore = getSessionSummary(registryRoot, projectId);
  const activityPaths = recentActivityPaths(summaryBefore);
  const unloggedChanges = snapshot.changed_files.filter((file) => !activityPaths.has(file.path));
  const activitiesWritten: SharedSessionActivity[] = [];

  const snapshotActivity = appendSessionActivity(registryRoot, projectId, {
    actor: "codex",
    source: "cli",
    kind: "workspace_snapshot",
    status: snapshot.git_available ? "success" : "warning",
    summary: snapshot.git_available
      ? `Workspace snapshot: ${snapshot.changed_count} changed file(s).`
      : "Workspace snapshot: git status unavailable.",
    paths: snapshot.changed_files.map((file) => file.path),
    metadata: {
      branch: snapshot.branch,
      clean: snapshot.clean,
      changed_count: snapshot.changed_count,
      staged_count: snapshot.staged_count,
      unstaged_count: snapshot.unstaged_count,
      untracked_count: snapshot.untracked_count,
      changed_files_truncated: snapshot.changed_files_truncated,
      changed_files: snapshot.changed_files,
      raw_diff_stored: false,
      content_stored: false,
      warning: snapshot.warning ?? null
    }
  });
  activitiesWritten.push(snapshotActivity.activity);

  if (snapshot.git_available) {
    const changedSummary = appendSessionActivity(registryRoot, projectId, {
      actor: "codex",
      source: "cli",
      kind: "changed_files_summary",
      status: snapshot.changed_count ? "warning" : "success",
      summary: snapshot.changed_count ? `Changed files summary: ${snapshot.changed_count} file(s).` : "Changed files summary: clean workspace.",
      paths: snapshot.changed_files.map((file) => file.path),
      metadata: {
        changed_count: snapshot.changed_count,
        files: snapshot.changed_files,
        raw_diff_stored: false,
        content_stored: false
      }
    });
    activitiesWritten.push(changedSummary.activity);
  }

  for (const change of unloggedChanges) {
    const gap = appendSessionActivity(registryRoot, projectId, {
      actor: "codex",
      source: "cli",
      kind: "activity_gap_detected",
      status: "warning",
      summary: `Activity gap detected for ${change.path}.`,
      paths: [change.path],
      metadata: {
        path: change.path,
        git_status: change.status,
        reason: "changed_file_without_recent_activity",
        bytes: change.bytes ?? null,
        added_lines: change.added_lines ?? null,
        removed_lines: change.removed_lines ?? null,
        binary: change.binary ?? false,
        raw_diff_stored: false,
        content_stored: false
      }
    });
    activitiesWritten.push(gap.activity);
  }

  return {
    ok: true,
    project_id: projectId,
    snapshot,
    activity_paths: [...activityPaths].sort(),
    unlogged_changes: unloggedChanges,
    activities_written: activitiesWritten,
    status: unloggedChanges.length || !snapshot.git_available ? "warn" : "pass"
  };
}

export function verifyWorkspaceFile(
  registryRoot: string,
  projectRoot: string,
  projectId: string,
  relativePathInput: string,
  expectedSha256?: string
): FileVerifyResult {
  const safePath = resolveSafeWorkspacePath(projectRoot, relativePathInput);
  const stat = fs.statSync(safePath.absolutePath);
  if (!stat.isFile()) {
    throw new WorkspaceActivityError("not_a_file", "Requested path is not a file.");
  }
  if (stat.size > MAX_VERIFY_BYTES) {
    throw new WorkspaceActivityError("file_too_large", "File is too large for safe metadata verification.");
  }
  const buffer = fs.readFileSync(safePath.absolutePath);
  if (isBinaryBuffer(buffer) || BINARY_EXTENSIONS.has(path.extname(safePath.relativePath).toLowerCase())) {
    throw new WorkspaceActivityError("binary_file", "Binary files cannot be verified by the safe text file verifier.");
  }
  const text = decodeUtf8(buffer);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const expected = expectedSha256?.trim().toLowerCase();
  if (expected !== undefined && !/^[a-f0-9]{64}$/.test(expected)) {
    throw new WorkspaceActivityError("invalid_hash", "Expected sha256 must be a 64-character hex string.");
  }
  const verified = expected ? sha256 === expected : null;
  const result = appendSessionActivity(registryRoot, projectId, {
    actor: "codex",
    source: "cli",
    kind: "file_verify",
    status: verified === false ? "fail" : "success",
    summary: verified === false ? `File verification failed: ${safePath.relativePath}.` : `File verified: ${safePath.relativePath}.`,
    paths: [safePath.relativePath],
    metadata: {
      path: safePath.relativePath,
      bytes: stat.size,
      line_count: countLines(text),
      sha256,
      expected_sha256: expected ?? null,
      verified,
      content_stored: false
    }
  });

  return {
    ok: true,
    project_id: projectId,
    path: safePath.relativePath,
    bytes: stat.size,
    line_count: countLines(text),
    sha256,
    ...(expected ? { expected_sha256: expected } : {}),
    verified,
    activity: result.activity,
    summary: result.summary,
    revision: result.revision
  };
}

export function formatWorkspaceReconcile(result: WorkspaceReconcileResult): string {
  return [
    `Workspace reconcile: ${result.project_id}`,
    `Status: ${result.status.toUpperCase()}`,
    `Git available: ${result.snapshot.git_available ? "yes" : "no"}`,
    `Branch: ${result.snapshot.branch || "unknown"}`,
    `Changed files: ${result.snapshot.changed_count}`,
    `Unlogged changes: ${result.unlogged_changes.length}`,
    "",
    "Changed files:",
    ...(result.snapshot.changed_files.length
      ? result.snapshot.changed_files.map((file) => `- ${file.status} ${file.path}`)
      : ["- None"]),
    "",
    "Activities written:",
    ...(result.activities_written.length
      ? result.activities_written.map((activity) => `- ${activity.id} ${activity.kind}/${activity.status}: ${activity.summary}`)
      : ["- None"])
  ].join("\n");
}

export function formatFileVerify(result: FileVerifyResult): string {
  return [
    `File verify: ${result.path}`,
    `Bytes: ${result.bytes}`,
    `Lines: ${result.line_count}`,
    `SHA-256: ${result.sha256}`,
    `Verified: ${result.verified === null ? "not requested" : result.verified ? "yes" : "no"}`,
    `Activity: ${result.activity.id}`
  ].join("\n");
}

export function findWorkspaceActivityGaps(registryRoot: string, projectRoot: string, projectId: string): WorkspaceChangedFile[] {
  const snapshot = createWorkspaceSnapshot(projectRoot, projectId);
  if (!snapshot.git_available) {
    return [];
  }
  return snapshot.changed_files.filter((file) => !recentActivityPaths(getSessionSummary(registryRoot, projectId)).has(file.path));
}

function recentActivityPaths(summary: SharedSessionSummaryFile): Set<string> {
  const paths = new Set<string>();
  for (const activity of summary.recent_activity) {
    for (const activityPath of activity.paths ?? []) {
      paths.add(normalizePosix(activityPath));
    }
    const metadataPath = activity.metadata?.path;
    if (typeof metadataPath === "string") {
      paths.add(normalizePosix(metadataPath));
    }
  }
  for (const evidence of summary.recent_evidence) {
    if (evidence.path) {
      paths.add(normalizePosix(evidence.path));
    }
  }
  return paths;
}

function parseGitStatus(input: string): {
  files: Array<{ path: string; status: string }>;
  staged_count: number;
  unstaged_count: number;
  untracked_count: number;
} {
  const files: Array<{ path: string; status: string }> = [];
  let staged_count = 0;
  let unstaged_count = 0;
  let untracked_count = 0;
  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const code = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    const filePath = normalizeStatusPath(rawPath);
    if (!filePath || isBlockedWorkspacePath(filePath)) {
      continue;
    }
    if (code === "??") {
      untracked_count += 1;
    } else {
      if (code[0] && code[0] !== " ") {
        staged_count += 1;
      }
      if (code[1] && code[1] !== " ") {
        unstaged_count += 1;
      }
    }
    files.push({ path: filePath, status: code.trim() || code });
  }
  return { files, staged_count, unstaged_count, untracked_count };
}

function readDiffStats(projectRoot: string, changedPaths: string[]): Map<string, { added_lines: number | null; removed_lines: number | null; binary: boolean; large_diff_truncated: boolean }> {
  const stats = new Map<string, { added_lines: number | null; removed_lines: number | null; binary: boolean; large_diff_truncated: boolean }>();
  for (const relativePath of changedPaths.slice(0, MAX_DIFF_FILES)) {
    const combined = [git(projectRoot, ["diff", "--numstat", "--", relativePath]), git(projectRoot, ["diff", "--cached", "--numstat", "--", relativePath])];
    let added = 0;
    let removed = 0;
    let binary = false;
    let seen = false;
    for (const result of combined) {
      if (!result.ok || !result.stdout.trim()) {
        continue;
      }
      for (const line of result.stdout.trim().split(/\r?\n/)) {
        const [rawAdded, rawRemoved] = line.split(/\t/);
        seen = true;
        if (rawAdded === "-" || rawRemoved === "-") {
          binary = true;
          continue;
        }
        added += Number.parseInt(rawAdded, 10) || 0;
        removed += Number.parseInt(rawRemoved, 10) || 0;
      }
    }
    if (seen) {
      stats.set(relativePath, { added_lines: binary ? null : added, removed_lines: binary ? null : removed, binary, large_diff_truncated: false });
    }
  }
  for (const relativePath of changedPaths.slice(MAX_DIFF_FILES)) {
    stats.set(relativePath, { added_lines: null, removed_lines: null, binary: false, large_diff_truncated: true });
  }
  return stats;
}

function resolveSafeWorkspacePath(projectRootInput: string, relativePathInput: string): { absolutePath: string; relativePath: string } {
  const projectRoot = fs.realpathSync(projectRootInput);
  const relativePath = normalizeRelativePath(relativePathInput);
  if (isBlockedWorkspacePath(relativePath)) {
    throw new WorkspaceActivityError("blocked_path", "Requested path is blocked by workspace safety policy.");
  }
  const candidate = path.resolve(projectRoot, relativePath);
  if (!fs.existsSync(candidate)) {
    throw new WorkspaceActivityError("not_found", "Requested file was not found.");
  }
  const realCandidate = fs.realpathSync(candidate);
  if (!isPathInside(projectRoot, realCandidate)) {
    throw new WorkspaceActivityError("path_outside_project", "Requested path is outside the project root.");
  }
  return { absolutePath: realCandidate, relativePath };
}

function normalizeRelativePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new WorkspaceActivityError("invalid_path", "Path is required.");
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) || path.isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed) || trimmed.includes(":")) {
    throw new WorkspaceActivityError("invalid_path", "Path must be project-relative and cannot be absolute, a URL, or a drive path.");
  }
  const parts = trimmed.split(/[\\/]+/);
  if (parts.some((part) => part === ".." || part === "")) {
    throw new WorkspaceActivityError("invalid_path", "Path must not contain traversal or empty segments.");
  }
  return normalizePosix(path.normalize(parts.join(path.sep)));
}

function normalizeStatusPath(input: string): string {
  const renamedPath = input.includes(" -> ") ? input.split(" -> ").at(-1) ?? input : input;
  return normalizePosix(renamedPath.replace(/^"|"$/g, ""));
}

function isBlockedWorkspacePath(relativePath: string): boolean {
  const normalized = normalizePosix(relativePath).toLowerCase();
  const parts = normalized.split("/");
  const basename = path.posix.basename(normalized);
  if (parts.includes("node_modules") || parts.includes(".git")) {
    return true;
  }
  if (normalized === ".agentbridge/local_token" || basename === "local_token" || basename === "id_rsa" || basename === "id_ed25519") {
    return true;
  }
  if (basename === ".env" || basename.startsWith(".env.")) {
    return true;
  }
  return PRIVATE_EXTENSIONS.has(path.posix.extname(basename).toLowerCase());
}

function isBinaryBuffer(buffer: Buffer): boolean {
  if (buffer.includes(0)) {
    return true;
  }
  try {
    TEXT_DECODER.decode(buffer);
    return false;
  } catch {
    return true;
  }
}

function decodeUtf8(buffer: Buffer): string {
  try {
    return TEXT_DECODER.decode(buffer);
  } catch {
    throw new WorkspaceActivityError("binary_file", "File is not valid UTF-8 text.");
  }
}

function countLines(content: string): number {
  if (!content) {
    return 0;
  }
  return content.split(/\r?\n/).length;
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function safeStat(filePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch {
    return undefined;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function normalizePosix(input: string): string {
  return input.split(path.sep).join("/").replace(/\\/g, "/");
}
