import { spawnSync } from "node:child_process";
import { redactSecrets } from "./redact.js";
import type { CaptureMode, GitInfo } from "./types.js";

function runGit(root: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });

  return {
    ok: result.status === 0,
    stdout: typeof result.stdout === "string" ? result.stdout.trimEnd() : "",
    stderr:
      typeof result.stderr === "string" && result.stderr
        ? result.stderr.trimEnd()
        : result.error instanceof Error
          ? result.error.message
          : ""
  };
}

function parseChangedFiles(status: string): string[] {
  return status
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("##"))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

export function getGitInfo(root: string, mode: CaptureMode): GitInfo {
  const inside = runGit(root, ["rev-parse", "--is-inside-work-tree"]);

  if (!inside.ok || inside.stdout !== "true") {
    return {
      available: false,
      branch: "unavailable",
      status: "Git repository unavailable.",
      changedFiles: [],
      diffStat: "Git diff unavailable.",
      diff: "Git diff unavailable.",
      recentCommits: "Recent commits unavailable.",
      error: inside.stderr || "Not a git repository."
    };
  }

  const branch = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = runGit(root, ["status", "--short", "--branch"]);
  const unstagedStat = runGit(root, ["diff", "--stat"]);
  const stagedStat = runGit(root, ["diff", "--cached", "--stat"]);
  const recentCommits = runGit(root, ["log", "--oneline", "-n", "5"]);

  let diff = "";
  if (mode === "full" || mode === "raw") {
    const unstagedDiff = runGit(root, ["diff", "--no-ext-diff"]);
    const stagedDiff = runGit(root, ["diff", "--cached", "--no-ext-diff"]);
    diff = [
      unstagedDiff.stdout ? "## Unstaged Diff\n\n```diff\n" + unstagedDiff.stdout + "\n```" : "",
      stagedDiff.stdout ? "## Staged Diff\n\n```diff\n" + stagedDiff.stdout + "\n```" : ""
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const diffStat = [unstagedStat.stdout, stagedStat.stdout].filter(Boolean).join("\n");
  const statusText = status.stdout || "Clean working tree.";

  return {
    available: true,
    branch: branch.stdout || "unknown",
    status: redactSecrets(statusText),
    changedFiles: parseChangedFiles(statusText),
    diffStat: redactSecrets(diffStat || "No diff."),
    diff: redactSecrets(diff || "Full diff omitted in short mode."),
    recentCommits: redactSecrets(recentCommits.stdout || "No commits found.")
  };
}
