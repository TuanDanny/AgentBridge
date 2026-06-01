import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const tempRoots: string[] = [];
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function runCli(root: string, ...args: string[]): string {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
}

function run(root: string, command: string, args: string[] = []): string {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("compiled CLI smoke tests", () => {
  it("runs the Phase 1 workflow in an empty folder", () => {
    const root = makeTempRoot("agentbridge-cli-empty-");

    expect(runCli(root, "init")).toContain("AgentBridge");
    runCli(root, "capture", "--mode", "short");
    runCli(root, "prompt");
    runCli(root, "result");
    runCli(root, "review");
    const status = runCli(root, "status");

    expect(status).toContain("Status: review_ready");
    expect(fs.existsSync(path.join(root, ".agentbridge", "codex_prompt.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".agentbridge", "chatgpt_review.md"))).toBe(true);
  });

  it("captures staged and unstaged git changes while redacting token-like values", () => {
    const root = makeTempRoot("agentbridge-cli-git-");
    run(root, "git", ["init"]);
    run(root, "git", ["config", "user.email", "agentbridge@example.test"]);
    run(root, "git", ["config", "user.name", "AgentBridge Test"]);
    fs.writeFileSync(path.join(root, "app.txt"), "initial\n", "utf8");
    run(root, "git", ["add", "app.txt"]);
    run(root, "git", ["commit", "-m", "initial"]);

    fs.writeFileSync(path.join(root, "app.txt"), "OPENAI_API_KEY=sk-123456789012345678901234\n", "utf8");
    fs.writeFileSync(path.join(root, "staged.txt"), "staged\n", "utf8");
    run(root, "git", ["add", "staged.txt"]);

    runCli(root, "capture", "--mode", "full");

    const context = fs.readFileSync(path.join(root, ".agentbridge", "project_context.md"), "utf8");
    expect(context).toContain("app.txt");
    expect(context).toContain("staged.txt");
    expect(context).toContain("[REDACTED]");
    expect(context).not.toContain("sk-123456789012345678901234");
  });

  it("supports Codex dry-run handoff without launching Codex", () => {
    const root = makeTempRoot("agentbridge-cli-codex-");

    const output = runCli(root, "codex", "--run", "--dry-run", "--codex-command", "codex-test");

    expect(output).toContain("Dry run: codex-test");
    expect(fs.existsSync(path.join(root, ".agentbridge", "codex_prompt.md"))).toBe(true);
  });

  it("supports group companion CLI commands", () => {
    const root = makeTempRoot("agentbridge-cli-group-");

    expect(runCli(root, "group", "brief")).toContain("group_brief.md");
    expect(runCli(root, "group", "handoff")).toContain("group_handoff.md");
    expect(runCli(root, "group", "decision-template")).toContain("group_decision.md");
    const status = runCli(root, "group", "status");

    expect(status).toContain("Group brief exists: yes");
    expect(status).toContain("Group handoff exists: yes");
    expect(status).toContain("Group decision exists: yes");
  });
});
