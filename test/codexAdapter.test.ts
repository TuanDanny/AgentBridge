import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodexRunCommand, loadCodexHandoff } from "../src/codexAdapter.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-codex-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Codex adapter", () => {
  it("creates a prompt when the handoff file does not exist", () => {
    const root = makeTempRoot();
    const handoff = loadCodexHandoff(root);

    expect(handoff.promptPath).toContain(path.join(".agentbridge", "codex_prompt.md"));
    expect(handoff.prompt).toContain("# Task for Codex");
    expect(fs.existsSync(handoff.promptPath)).toBe(true);
  });

  it("builds a conservative explicit Codex run command", () => {
    const result = buildCodexRunCommand("Do the task.", { codexCommand: "codex-test" });

    expect(result.command).toBe("codex-test");
    expect(result.args).toEqual(["exec", "Do the task."]);
  });
});
