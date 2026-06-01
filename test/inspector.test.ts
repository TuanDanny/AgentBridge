import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexChangesSummary, createProjectInspectPacket, createProjectInspectorSnapshot } from "../src/inspector.js";
import { captureProject } from "../src/core.js";
import { createApproval } from "../src/safety.js";

const tempRoots: string[] = [];

function makeTempRoot(prefix = "agentbridge-inspector-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function run(root: string, command: string, args: string[] = []): string {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
}

function bridgeFile(root: string, name: string): string {
  return path.join(root, ".agentbridge", name);
}

function writeBridgeFile(root: string, name: string, content: string): void {
  fs.mkdirSync(path.dirname(bridgeFile(root, name)), { recursive: true });
  fs.writeFileSync(bridgeFile(root, name), content, "utf8");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("project inspector", () => {
  it("returns project, repo, and session fields for the current project", () => {
    const root = makeTempRoot();
    captureProject(root, "short");

    const snapshot = createProjectInspectorSnapshot(root);

    expect(snapshot.ok).toBe(true);
    expect(snapshot.project.name).toBe(path.basename(root));
    expect(snapshot.project.root_hint).toBe(root);
    expect(snapshot.repo.branch).toBeDefined();
    expect(snapshot.agentbridge.next_action).toBe("create_codex_prompt");
    expect(snapshot.codex.chatgpt_plan_summary).toContain("# ChatGPT Plan");
    expect(snapshot.safety.pending_approvals).toBe(0);
    expect(snapshot.limits.redacted).toBe(true);
  });

  it("does not report fake changed files when git is unavailable", () => {
    const root = makeTempRoot();

    const snapshot = createProjectInspectorSnapshot(root);

    expect(snapshot.repo.available).toBe(false);
    expect(snapshot.repo.changed_files).toEqual([]);
    expect(snapshot.repo.changed_file_summary).toEqual([]);
    expect(snapshot.codex.changed_file_summary).toEqual([]);
  });

  it("captures changed files in a git repository", () => {
    const root = makeTempRoot();
    run(root, "git", ["init"]);
    run(root, "git", ["config", "user.email", "agentbridge@example.test"]);
    run(root, "git", ["config", "user.name", "AgentBridge Test"]);
    fs.writeFileSync(path.join(root, "app.txt"), "initial\n", "utf8");
    run(root, "git", ["add", "app.txt"]);
    run(root, "git", ["commit", "-m", "initial"]);
    fs.writeFileSync(path.join(root, "app.txt"), "changed\n", "utf8");
    fs.writeFileSync(path.join(root, "new.txt"), "new\n", "utf8");

    const snapshot = createProjectInspectorSnapshot(root);

    expect(snapshot.repo.available).toBe(true);
    expect(snapshot.repo.clean).toBe(false);
    expect(snapshot.repo.changed_files).toEqual(expect.arrayContaining(["app.txt", "new.txt"]));
    expect(snapshot.repo.changed_file_summary.map((file) => file.path)).toEqual(expect.arrayContaining(["app.txt", "new.txt"]));
  });

  it("includes Codex progress/result and pending approval state", () => {
    const root = makeTempRoot();
    captureProject(root, "short");
    writeBridgeFile(root, "codex_progress.md", "# Codex Progress\n\nImplemented inspector core.");
    writeBridgeFile(root, "codex_result.md", "# Codex Result\n\nChanged inspector files.");
    createApproval(root, {
      action: "run_command",
      command: "git push --force",
      risk: "high"
    });

    const snapshot = createProjectInspectorSnapshot(root);
    const changes = createCodexChangesSummary(root);

    expect(snapshot.codex.progress_summary).toContain("Implemented inspector core.");
    expect(snapshot.codex.result_summary).toContain("Changed inspector files.");
    expect(snapshot.safety.pending_approvals).toBe(1);
    expect(snapshot.safety.risk_flags[0]).toContain("high");
    expect(changes.codex_progress).toContain("Implemented inspector core.");
    expect(changes.codex_result).toContain("Changed inspector files.");
  });

  it("redacts token-like values, local token values, and private keys", () => {
    const root = makeTempRoot();
    const localToken = "local-token-value-1234567890";
    writeBridgeFile(root, "local_token", localToken);
    writeBridgeFile(
      root,
      "chatgpt_plan.md",
      [
        "OPENAI_API_KEY=sk-123456789012345678901234",
        "GITHUB_TOKEN=ghp_testsecret",
        `Exact token: ${localToken}`
      ].join("\n")
    );
    writeBridgeFile(
      root,
      "codex_result.md",
      `-----BEGIN PRIVATE KEY-----
abc123
-----END PRIVATE KEY-----`
    );

    const snapshot = createProjectInspectorSnapshot(root);
    const serialized = JSON.stringify(snapshot);

    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("sk-123456789012345678901234");
    expect(serialized).not.toContain("ghp_testsecret");
    expect(serialized).not.toContain(localToken);
    expect(serialized).not.toContain("abc123");
  });

  it("truncates large content with a clear marker", () => {
    const root = makeTempRoot();
    writeBridgeFile(root, "codex_result.md", `# Codex Result\n\n${"A".repeat(1000)}`);

    const snapshot = createProjectInspectorSnapshot(root, { maxCharsPerField: 160 });

    expect(snapshot.codex.result_summary).toContain("[TRUNCATED by AgentBridge inspector]");
    expect(snapshot.limits.truncated).toBe(true);
    expect(snapshot.limits.truncated_fields).toContain("codex.result_summary");
  });

  it("creates a redacted ChatGPT inspect packet", () => {
    const root = makeTempRoot();
    writeBridgeFile(root, "chatgpt_plan.md", "TOKEN=secret-value");

    const packet = createProjectInspectPacket(root);
    const content = fs.readFileSync(packet.path, "utf8");

    expect(packet.path).toContain(path.join(".agentbridge", "project_inspect_packet.md"));
    expect(content).toContain("# AgentBridge Project Inspect Packet");
    expect(content).toContain("[REDACTED]");
    expect(content).not.toContain("secret-value");
  });
});
