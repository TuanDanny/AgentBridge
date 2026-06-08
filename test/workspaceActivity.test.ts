import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/setupDoctor.js";
import { getSessionSummary } from "../src/sessionStore.js";
import {
  createWorkspaceSnapshot,
  reconcileWorkspaceActivity,
  verifyWorkspaceFile
} from "../src/workspaceActivity.js";

const tempRoots: string[] = [];

function makeGitRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-workspace-activity-"));
  tempRoots.push(root);
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore", windowsHide: true });
  fs.writeFileSync(path.join(root, ".gitignore"), ".agentbridge/\n", "utf8");
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("workspace activity and reconcile", () => {
  it("records workspace snapshots and activity gaps for unlogged changed files", () => {
    const root = makeGitRoot();
    fs.writeFileSync(path.join(root, "kiemtrasuco.txt"), "safe metadata only\n", "utf8");

    const result = reconcileWorkspaceActivity(root, root, "AgentAI");
    expect(result.status).toBe("warn");
    expect(result.snapshot.git_available).toBe(true);
    expect(result.snapshot.changed_count).toBe(2);
    expect(result.snapshot.changed_files.map((file) => file.path)).toEqual(expect.arrayContaining([".gitignore", "kiemtrasuco.txt"]));
    expect(result.unlogged_changes.map((file) => file.path)).toEqual(expect.arrayContaining(["kiemtrasuco.txt"]));
    expect(result.activities_written.map((activity) => activity.kind)).toEqual(
      expect.arrayContaining(["workspace_snapshot", "changed_files_summary", "activity_gap_detected"])
    );

    const summary = getSessionSummary(root, "AgentAI");
    expect(summary.recent_activity.some((activity) => activity.kind === "workspace_snapshot")).toBe(true);
    expect(summary.recent_activity.some((activity) => activity.kind === "activity_gap_detected" && activity.paths.includes("kiemtrasuco.txt"))).toBe(true);

    const sessionDir = path.join(root, ".agentbridge", "sessions", "AgentAI", summary.session_id);
    const activityText = fs.readFileSync(path.join(sessionDir, "activity.jsonl"), "utf8");
    expect(activityText).toContain("content_stored");
    expect(activityText).not.toContain("safe metadata only");
    expect(activityText).not.toContain("diff --git");
  });

  it("verifies safe text file metadata without storing raw content", () => {
    const root = makeGitRoot();
    const content = "first line\nsecond line\n";
    fs.writeFileSync(path.join(root, "proof.txt"), content, "utf8");
    const expectedHash = crypto.createHash("sha256").update(Buffer.from(content)).digest("hex");

    const result = verifyWorkspaceFile(root, root, "AgentAI", "proof.txt", expectedHash);
    expect(result.verified).toBe(true);
    expect(result.sha256).toBe(expectedHash);
    expect(result.line_count).toBe(3);
    expect(result.activity.kind).toBe("file_verify");
    expect(result.activity.metadata).toMatchObject({
      path: "proof.txt",
      sha256: expectedHash,
      expected_sha256: expectedHash,
      verified: true,
      content_stored: false
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(content.trim());
    expect(serialized).not.toContain("first line");
  });

  it("stores diff summary counts without raw diff text", () => {
    const root = makeGitRoot();
    fs.writeFileSync(path.join(root, "tracked.txt"), "one\n", "utf8");
    execFileSync("git", ["add", "tracked.txt"], { cwd: root, stdio: "ignore", windowsHide: true });
    fs.writeFileSync(path.join(root, "tracked.txt"), "one\ntwo\nthree\n", "utf8");

    const snapshot = createWorkspaceSnapshot(root, "AgentAI");
    const tracked = snapshot.changed_files.find((file) => file.path === "tracked.txt");
    expect(tracked).toBeDefined();
    expect((tracked?.added_lines ?? 0) + (tracked?.removed_lines ?? 0)).toBeGreaterThan(0);

    const result = reconcileWorkspaceActivity(root, root, "AgentAI");
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("added_lines");
    expect(serialized).toContain("removed_lines");
    expect(serialized).toContain('"raw_diff_stored":false');
    expect(serialized).not.toContain("diff --git");
    expect(serialized).not.toContain("two\\nthree");
  });

  it("blocks sensitive, traversal, binary, and large files during file verification", () => {
    const root = makeGitRoot();
    fs.mkdirSync(path.join(root, ".agentbridge"), { recursive: true });
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=do-not-read\n", "utf8");
    fs.writeFileSync(path.join(root, ".agentbridge", "local_token"), "fake-local-token\n", "utf8");
    fs.writeFileSync(path.join(root, "secret.pem"), "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n", "utf8");
    fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    fs.writeFileSync(path.join(root, "large.txt"), `${"x".repeat(1024 * 1024 + 1)}`, "utf8");

    for (const blockedPath of [".env", ".agentbridge/local_token", "secret.pem", "../outside.txt", path.join(root, "large.txt"), "binary.bin"]) {
      expect(() => verifyWorkspaceFile(root, root, "AgentAI", blockedPath)).toThrow();
    }
  });

  it("doctor warns when changed files lack recent activity", async () => {
    const root = makeGitRoot();
    fs.writeFileSync(path.join(root, "unlogged.txt"), "unlogged metadata gap\n", "utf8");

    const result = await runDoctor(root, { projectId: "AgentAI" });
    const check = result.checks.find((item) => item.name === "activity_trace_coverage");
    expect(check).toBeDefined();
    expect(check?.status).toBe("WARN");
    expect(check?.next_step).toContain("session reconcile AgentAI");
  });
});
