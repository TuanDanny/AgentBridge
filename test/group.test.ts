import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureProject } from "../src/core.js";
import {
  applyGroupDecision,
  createGroupBrief,
  createGroupDecisionTemplate,
  createGroupHandoff,
  getGroupStatus
} from "../src/group.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-group-"));
  tempRoots.push(root);
  return root;
}

function bridgeFile(root: string, name: string): string {
  return path.join(root, ".agentbridge", name);
}

function readBridgeFile(root: string, name: string): string {
  return fs.readFileSync(bridgeFile(root, name), "utf8");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("group chat companion", () => {
  it("creates a redacted group brief with project, branch, and next action", () => {
    const root = makeTempRoot();
    captureProject(root, "short");
    fs.writeFileSync(bridgeFile(root, "chatgpt_plan.md"), "Use API_TOKEN=abc123 while planning.", "utf8");
    fs.writeFileSync(bridgeFile(root, "codex_prompt.md"), "Prompt with PASSWORD=hunter2.", "utf8");

    const result = createGroupBrief(root);
    const brief = readBridgeFile(root, "group_brief.md");

    expect(result.changedFiles).toContain("group_brief.md");
    expect(brief).toContain("# Group Chat Brief");
    expect(brief).toContain(`Project name: ${path.basename(root)}`);
    expect(brief).toContain("Branch:");
    expect(brief).toContain("Next action:");
    expect(brief).toContain("[REDACTED]");
    expect(brief).not.toContain("abc123");
    expect(brief).not.toContain("hunter2");
  });

  it("creates a redacted handoff and reports group status", () => {
    const root = makeTempRoot();
    captureProject(root, "short");
    fs.writeFileSync(bridgeFile(root, "codex_result.md"), "Implemented with SECRET=super-secret.", "utf8");

    createGroupBrief(root);
    const result = createGroupHandoff(root);
    const handoff = readBridgeFile(root, "group_handoff.md");
    const status = getGroupStatus(root);

    expect(result.changedFiles).toContain("group_handoff.md");
    expect(handoff).toContain("# Group Chat Handoff");
    expect(handoff).toContain("[REDACTED]");
    expect(handoff).not.toContain("super-secret");
    expect(status).toContain("Group brief exists: yes");
    expect(status).toContain("Group handoff exists: yes");
  });

  it("creates a decision template and applies a redacted group decision", () => {
    const root = makeTempRoot();
    captureProject(root, "short");

    createGroupDecisionTemplate(root);
    expect(readBridgeFile(root, "group_decision.md")).toContain("# Group Decision");

    fs.writeFileSync(
      bridgeFile(root, "group_decision.md"),
      [
        "# Group Decision",
        "",
        "## Decision Summary",
        "",
        "Ask Codex to implement the group companion workflow with PASSWORD=hunter2.",
        "",
        "## Instructions For Codex",
        "",
        "Implement the selected workflow and run tests."
      ].join("\n"),
      "utf8"
    );

    const result = applyGroupDecision(root);
    const plan = readBridgeFile(root, "chatgpt_plan.md");
    const prompt = readBridgeFile(root, "codex_prompt.md");
    const decision = readBridgeFile(root, "group_decision.md");
    const session = JSON.parse(readBridgeFile(root, "session.json"));
    const audit = readBridgeFile(root, "audit.jsonl");

    expect(result.changedFiles).toContain("codex_prompt.md");
    expect(plan).toContain("Imported from .agentbridge/group_decision.md");
    expect(plan).toContain("[REDACTED]");
    expect(plan).not.toContain("hunter2");
    expect(prompt).toContain("Implement the selected workflow");
    expect(prompt).not.toContain("hunter2");
    expect(decision).toContain("[REDACTED]");
    expect(decision).not.toContain("hunter2");
    expect(session.status).toBe("prompt_ready");
    expect(session.next_action).toBe("codex_execute_prompt");
    expect(audit).toContain("group.apply_decision");
  });
});
