import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureProject, createChatGptReview, createCodexPrompt, initProject, prepareCodexResult } from "../src/core.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-core-"));
  tempRoots.push(root);
  return root;
}

function read(root: string, name: string): string {
  return fs.readFileSync(path.join(root, ".agentbridge", name), "utf8");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("core workflow", () => {
  it("initializes shared session files and preserves user-authored files", () => {
    const root = makeTempRoot();
    const init = initProject(root);

    expect(init.changedFiles).toContain("session.json");
    expect(fs.existsSync(path.join(root, ".agentbridge", "config.toml"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".agentbridge", "snapshots"))).toBe(true);

    const customIntent = "# User Intent\n\nKeep this text.\n";
    fs.writeFileSync(path.join(root, ".agentbridge", "user_intent.md"), customIntent, "utf8");

    initProject(root);

    expect(read(root, "user_intent.md")).toBe(customIntent);
  });

  it("captures context outside git and still creates downstream prompt and review files", () => {
    const root = makeTempRoot();

    captureProject(root, "short");
    createCodexPrompt(root);
    prepareCodexResult(root);
    createChatGptReview(root);

    expect(read(root, "project_context.md")).toContain("Git repository unavailable.");
    expect(read(root, "codex_prompt.md")).toContain("# Task for Codex");
    expect(read(root, "chatgpt_review.md")).toContain("# ChatGPT Review Packet");

    const session = JSON.parse(read(root, "session.json"));
    expect(session.status).toBe("review_ready");
    expect(session.next_action).toBe("user_review");
  });
});
