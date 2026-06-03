import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { appendAudit, readSession } from "./session.js";
import { bridgePath, getBridgeDir, getProjectName, resolveProjectRoot } from "./paths.js";
import { getGitInfo } from "./git.js";
import { pathExists, readTextIfExists, writeText } from "./fsx.js";
import { redactSecrets } from "./redact.js";
import { listApprovals } from "./safety.js";
import { projectRootHint } from "./registry.js";
import { generatedNotice } from "./templates.js";
import type { ApprovalItem } from "./types.js";

export interface InspectorOptions {
  maxCharsPerField?: number;
  includeDiff?: boolean;
  projectId?: string;
  projectName?: string;
  registered?: boolean;
}

export interface InspectorChangedFile {
  path: string;
  status: string;
  summary: string;
}

export interface ProjectInspectorSnapshot {
  ok: true;
  project: {
    id: string;
    name: string;
    root_hint: string;
    registered: boolean;
  };
  repo: {
    available: boolean;
    branch: string;
    clean: boolean;
    status_short: string;
    changed_files: string[];
    changed_file_summary: InspectorChangedFile[];
    diff_summary: string;
    recent_commits: string[];
    recent_tags: string[];
    error?: string;
  };
  agentbridge: {
    session_id: string;
    session_status: string;
    user_goal: string;
    next_action: string;
    chatgpt_plan_status: string;
    codex_task_status: string;
    last_test_status: string;
    updated_at: string;
  };
  codex: {
    chatgpt_plan_summary: string;
    progress_summary: string;
    result_summary: string;
    review_packet_summary: string;
    review_packet_stale: boolean;
    review_packet_stale_reason?: string;
    changed_file_summary: InspectorChangedFile[];
  };
  tests: {
    latest_summary: string;
    source: string;
    stale: boolean;
    stale_reason?: string;
  };
  repo_awareness: {
    has_inventory: boolean;
    known_limits: string[];
    fresh_test_log_status: "present" | "missing" | "unknown";
  };
  safety: {
    pending_approvals: number;
    risk_flags: string[];
    approvals: InspectorApproval[];
  };
  limits: {
    redacted: true;
    truncated: boolean;
    truncated_fields: string[];
    diff_truncated: boolean;
    max_chars_per_field: number;
  };
}

export interface InspectorApproval {
  id: string;
  action: string;
  command?: string;
  risk: string;
  status: string;
  stale: boolean;
  actionable: boolean;
  recommendation: string;
}

export interface CodexChangesSummary {
  ok: true;
  project_id: string;
  branch: string;
  clean: boolean;
  changed_files: InspectorChangedFile[];
  diff_summary: string;
  codex_progress: string;
  codex_result: string;
  limits: ProjectInspectorSnapshot["limits"];
}

const DEFAULT_MAX_CHARS = 6000;
const TRUNCATED_MARKER = "\n\n[TRUNCATED by AgentBridge inspector]";

function runGit(root: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });

  return {
    ok: result.status === 0,
    stdout: result.stdout.trimEnd(),
    stderr: result.stderr.trimEnd()
  };
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactForProject(root: string, input: string): string {
  let output = redactSecrets(input);
  const localToken = readTextIfExists(bridgePath(root, "local_token")).trim();
  if (localToken) {
    output = output.replace(new RegExp(escapeRegExp(localToken), "g"), "[REDACTED]");
  }
  output = output.replace(new RegExp(escapeRegExp(root), "gi"), projectRootHint(root));
  output = redactLocalPaths(output);
  return output;
}

function redactLocalPaths(input: string): string {
  return input.replace(/\b[A-Za-z]:\\[^\r\n`"'<>|]+/g, (match) => {
    const trailing = match.match(/[),.;:]+$/)?.[0] ?? "";
    const core = trailing ? match.slice(0, -trailing.length) : match;
    if (core.includes("\\...\\")) {
      return match;
    }
    const parsed = path.win32.parse(core);
    const name = path.win32.basename(core);
    if (!parsed.root || !name) {
      return match;
    }
    return `${path.win32.join(parsed.root, "...", name)}${trailing}`;
  });
}

function normalizeUnprovenStatusClaims(input: string): string {
  return input
    .replace(/(## Commands Run\s*\r?\n\s*)-\s*Not run yet\./gi, "$1No fresh command log was found.")
    .replace(/(## Tests\s*\r?\n\s*)Not run yet\./gi, "$1No fresh test log was found.")
    .replace(/(\bTests:\s*)Not run yet\.?/gi, "$1No fresh test log was found.")
    .replace(/(\bCommands Run:\s*)Not run yet\.?/gi, "$1No fresh command log was found.");
}

function truncateField(
  root: string,
  field: string,
  input: string,
  maxChars: number,
  truncatedFields: string[]
): string {
  const redacted = normalizeUnprovenStatusClaims(redactForProject(root, input)).trim();
  if (!redacted) {
    return "";
  }

  if (redacted.length <= maxChars) {
    return redacted;
  }

  truncatedFields.push(field);
  const sliceLength = Math.max(0, maxChars - TRUNCATED_MARKER.length);
  return `${redacted.slice(0, sliceLength).trimEnd()}${TRUNCATED_MARKER}`;
}

function readSummary(
  root: string,
  fileName: string,
  fallback: string,
  field: string,
  maxChars: number,
  truncatedFields: string[]
): string {
  const content = readTextIfExists(bridgePath(root, fileName), fallback);
  return truncateField(root, field, content, maxChars, truncatedFields) || fallback;
}

function splitLines(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseStatusFiles(status: string): InspectorChangedFile[] {
  return status
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("##"))
    .map((line) => {
      const statusCode = line.slice(0, 2).trim() || line.slice(0, 2);
      const filePath = line.slice(3).trim();
      return {
        path: filePath,
        status: statusCode,
        summary: summarizeStatus(statusCode)
      };
    })
    .filter((item) => item.path);
}

function summarizeStatus(status: string): string {
  if (status === "??") {
    return "Untracked file.";
  }
  if (status.includes("A")) {
    return "Added file.";
  }
  if (status.includes("M")) {
    return "Modified file.";
  }
  if (status.includes("D")) {
    return "Deleted file.";
  }
  if (status.includes("R")) {
    return "Renamed file.";
  }
  return "Changed file.";
}

function recentTags(root: string): string[] {
  const result = runGit(root, ["tag", "--sort=-creatordate", "--format=%(refname:short)"]);
  if (!result.ok || !result.stdout) {
    return [];
  }
  return splitLines(result.stdout).slice(0, 5);
}

function latestTestSummary(
  root: string,
  maxChars: number,
  truncatedFields: string[]
): { latest_summary: string; source: string; stale: boolean; stale_reason?: string } {
  const logPath = bridgePath(root, "logs/latest_test.txt");
  if (!pathExists(logPath)) {
    return {
      latest_summary: "No fresh test log was found.",
      source: "missing",
      stale: true,
      stale_reason: "No fresh test log was found."
    };
  }

  return {
    latest_summary: readSummary(root, "logs/latest_test.txt", "No fresh test log was found.", "tests.latest_summary", maxChars, truncatedFields),
    source: "logs/latest_test.txt",
    stale: false
  };
}

function bridgeMtime(root: string, fileName: string): number | undefined {
  const filePath = bridgePath(root, fileName);
  if (!pathExists(filePath)) {
    return undefined;
  }
  return fs.statSync(filePath).mtimeMs;
}

function reviewPacketFreshness(root: string): { stale: boolean; stale_reason?: string } {
  const reviewMtime = bridgeMtime(root, "chatgpt_review.md");
  if (reviewMtime === undefined) {
    return {
      stale: true,
      stale_reason: "No review packet file was found."
    };
  }

  const newerData = [
    "session.json",
    "logs/latest_test.txt",
    "codex_result.md",
    "codex_progress.md",
    "chatgpt_plan.md",
    "project_context.md",
    "approvals.json"
  ]
    .map((fileName) => bridgeMtime(root, fileName))
    .filter((mtime): mtime is number => mtime !== undefined)
    .some((mtime) => mtime > reviewMtime);

  if (newerData) {
    return {
      stale: true,
      stale_reason: "review packet older than current repo/session/test data"
    };
  }

  return { stale: false };
}

function nonActionableApproval(approval: ApprovalItem): boolean {
  return approval.risk === "high" && /\bgit\s+push\b.*\s--force(?:-with-lease)?\b/i.test(approval.command ?? "");
}

function approvalView(root: string, approval: ApprovalItem): InspectorApproval {
  const stale = nonActionableApproval(approval);
  const actionable = approval.status === "pending" && !stale;
  return {
    id: approval.id,
    action: redactForProject(root, approval.action),
    ...(approval.command ? { command: redactForProject(root, approval.command) } : {}),
    risk: approval.risk,
    status: approval.status,
    stale,
    actionable,
    recommendation: actionable ? "Review locally before approving." : "Do not run this command."
  };
}

export function projectIdFromName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

export function createProjectInspectorSnapshot(
  rootInput = process.cwd(),
  options: InspectorOptions = {}
): ProjectInspectorSnapshot {
  const root = resolveProjectRoot(rootInput);
  const maxChars = options.maxCharsPerField ?? DEFAULT_MAX_CHARS;
  const truncatedFields: string[] = [];
  const session = readSession(root);
  const projectName = options.projectName ?? getProjectName(root);
  const git = getGitInfo(root, options.includeDiff ? "full" : "short");
  const changedFileSummary = git.available ? parseStatusFiles(git.status) : [];
  const approvalViews = listApprovals(root).map((approval) => approvalView(root, approval));
  const pendingApprovals = approvalViews.filter((approval) => approval.status === "pending" && approval.actionable);
  const tests = latestTestSummary(root, maxChars, truncatedFields);
  const reviewFreshness = reviewPacketFreshness(root);
  const diffSummary = truncateField(root, "repo.diff_summary", git.diffStat, maxChars, truncatedFields) || "No diff.";

  const snapshot: ProjectInspectorSnapshot = {
    ok: true,
    project: {
      id: options.projectId ?? projectIdFromName(projectName),
      name: projectName,
      root_hint: redactForProject(root, projectRootHint(root)),
      registered: Boolean(options.registered)
    },
    repo: {
      available: git.available,
      branch: git.branch,
      clean: git.available ? git.changedFiles.length === 0 : false,
      status_short: truncateField(root, "repo.status_short", git.status, maxChars, truncatedFields) || git.status,
      changed_files: git.changedFiles.map((file) => redactForProject(root, file)),
      changed_file_summary: changedFileSummary.map((file) => ({
        path: redactForProject(root, file.path),
        status: file.status,
        summary: file.summary
      })),
      diff_summary: diffSummary,
      recent_commits: splitLines(truncateField(root, "repo.recent_commits", git.recentCommits, maxChars, truncatedFields)),
      recent_tags: recentTags(root).map((tag) => redactForProject(root, tag)),
      ...(git.error ? { error: redactForProject(root, git.error) } : {})
    },
    agentbridge: {
      session_id: session.session_id,
      session_status: session.status,
      user_goal: truncateField(root, "agentbridge.user_goal", session.user_goal, maxChars, truncatedFields),
      next_action: session.next_action,
      chatgpt_plan_status: session.chatgpt_plan_status,
      codex_task_status: session.codex_task_status,
      last_test_status: session.last_test_status,
      updated_at: session.updated_at
    },
    codex: {
      chatgpt_plan_summary: readSummary(
        root,
        "chatgpt_plan.md",
        "No ChatGPT plan has been written yet.",
        "codex.chatgpt_plan_summary",
        maxChars,
        truncatedFields
      ),
      progress_summary: readSummary(
        root,
        "codex_progress.md",
        "No Codex progress has been reported yet.",
        "codex.progress_summary",
        maxChars,
        truncatedFields
      ),
      result_summary: readSummary(
        root,
        "codex_result.md",
        "No Codex result has been submitted yet.",
        "codex.result_summary",
        maxChars,
        truncatedFields
      ),
      review_packet_summary: readSummary(
        root,
        "chatgpt_review.md",
        "No ChatGPT review packet has been created yet.",
        "codex.review_packet_summary",
        maxChars,
        truncatedFields
      ),
      review_packet_stale: reviewFreshness.stale,
      ...(reviewFreshness.stale_reason ? { review_packet_stale_reason: reviewFreshness.stale_reason } : {}),
      changed_file_summary: changedFileSummary.map((file) => ({
        path: redactForProject(root, file.path),
        status: file.status,
        summary: file.summary
      }))
    },
    tests,
    repo_awareness: {
      has_inventory: false,
      known_limits: [
        "inspectProject does not perform a full project inventory. Call getProjectTree for inventory, classification, candidates, and coverage warnings.",
        tests.stale ? "No fresh test log was found." : "Fresh test log metadata is available."
      ],
      fresh_test_log_status: tests.source === "missing" ? "missing" : tests.stale ? "unknown" : "present"
    },
    safety: {
      pending_approvals: pendingApprovals.length,
      risk_flags: approvalViews.map((approval) =>
        redactForProject(
          root,
          `${approval.risk}: ${approval.action}${approval.command ? ` (${approval.command})` : ""}; actionable=${approval.actionable}; stale=${approval.stale}; recommendation=${approval.recommendation}`
        )
      ),
      approvals: approvalViews
    },
    limits: {
      redacted: true,
      truncated: truncatedFields.length > 0,
      truncated_fields: [...new Set(truncatedFields)],
      diff_truncated: truncatedFields.includes("repo.diff_summary"),
      max_chars_per_field: maxChars
    }
  };

  return snapshot;
}

export function createCodexChangesSummary(rootInput = process.cwd(), options: InspectorOptions = {}): CodexChangesSummary {
  const snapshot = createProjectInspectorSnapshot(rootInput, options);
  return {
    ok: true,
    project_id: snapshot.project.id,
    branch: snapshot.repo.branch,
    clean: snapshot.repo.clean,
    changed_files: snapshot.codex.changed_file_summary,
    diff_summary: snapshot.repo.diff_summary,
    codex_progress: snapshot.codex.progress_summary,
    codex_result: snapshot.codex.result_summary,
    limits: snapshot.limits
  };
}

export function formatInspectorHuman(snapshot: ProjectInspectorSnapshot): string {
  const changedFiles = snapshot.repo.changed_file_summary.length
    ? snapshot.repo.changed_file_summary.map((file) => `- ${file.path} (${file.status}): ${file.summary}`).join("\n")
    : "- None";
  const commits = snapshot.repo.recent_commits.length ? snapshot.repo.recent_commits.map((commit) => `- ${commit}`).join("\n") : "- None";
  const tags = snapshot.repo.recent_tags.length ? snapshot.repo.recent_tags.map((tag) => `- ${tag}`).join("\n") : "- None";

  return `AgentBridge Project Inspector

Project: ${snapshot.project.name}
Root: ${snapshot.project.root_hint}
Branch: ${snapshot.repo.branch}
Repo: ${snapshot.repo.clean ? "clean" : "dirty"}
Git available: ${snapshot.repo.available ? "yes" : "no"}

Changed files:
${changedFiles}

Recent commits:
${commits}

Recent tags:
${tags}

Codex:
- ChatGPT plan: ${snapshot.codex.chatgpt_plan_summary}
- Last progress: ${snapshot.codex.progress_summary}
- Last result: ${snapshot.codex.result_summary}

Tests:
- Latest: ${snapshot.tests.latest_summary}

Next action:
- ${snapshot.agentbridge.next_action}

Safety:
- Pending approvals: ${snapshot.safety.pending_approvals}

Limits:
- Redacted: ${snapshot.limits.redacted ? "yes" : "no"}
- Truncated: ${snapshot.limits.truncated ? "yes" : "no"}
`;
}

export function formatCodexChangesHuman(summary: CodexChangesSummary): string {
  const changedFiles = summary.changed_files.length
    ? summary.changed_files.map((file) => `- ${file.path} (${file.status}): ${file.summary}`).join("\n")
    : "- None";

  return `AgentBridge Codex Changes

Project: ${summary.project_id}
Branch: ${summary.branch}
Repo: ${summary.clean ? "clean" : "dirty"}

Changed files:
${changedFiles}

Diff summary:
${summary.diff_summary}

Codex progress:
${summary.codex_progress}

Codex result:
${summary.codex_result}
`;
}

export function createProjectInspectPacket(rootInput = process.cwd(), options: InspectorOptions = {}): {
  path: string;
  snapshot: ProjectInspectorSnapshot;
} {
  const root = resolveProjectRoot(rootInput);
  const snapshot = createProjectInspectorSnapshot(root, options);
  const packet = `${generatedNotice}

# AgentBridge Project Inspect Packet

This packet is safe to paste into ChatGPT after reviewing it locally. It is redacted and truncated by AgentBridge.

\`\`\`json
${JSON.stringify(snapshot, null, 2)}
\`\`\`
`;
  const filePath = bridgePath(root, "project_inspect_packet.md");
  writeText(filePath, redactForProject(root, packet));
  appendAudit(root, "inspector.packet", {
    project_id: snapshot.project.id,
    truncated: snapshot.limits.truncated,
    changed_files: snapshot.repo.changed_files.length
  });

  return {
    path: filePath,
    snapshot
  };
}
