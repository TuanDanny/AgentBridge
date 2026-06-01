import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyCommand, createApproval, listApprovals, resolveApproval, scanTextForSecrets } from "../src/safety.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-safety-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("safety classifier", () => {
  it("classifies known destructive and remote-state commands", () => {
    expect(classifyCommand("git push --force").risk).toBe("high");
    expect(classifyCommand("rm -rf dist").blocked).toBe(true);
    expect(classifyCommand("git push origin main").requiresApproval).toBe(true);
    expect(classifyCommand("npm test").risk).toBe("low");
  });

  it("scans and redacts secret-like text", () => {
    const result = scanTextForSecrets("OPENAI_API_KEY=sk-123456789012345678901234");
    expect(result.found).toBe(true);
    expect(result.redacted).toContain("[REDACTED]");
  });
});

describe("approval store", () => {
  it("creates and resolves approval requests", () => {
    const root = makeTempRoot();
    const approval = createApproval(root, {
      actor: "codex",
      action: "run_command",
      command: "git push --force",
      reason: "Need to update remote branch."
    });

    expect(approval.status).toBe("pending");
    expect(approval.risk).toBe("high");
    expect(listApprovals(root, "pending")).toHaveLength(1);

    const approved = resolveApproval(root, approval.id, "approved");
    expect(approved.status).toBe("approved");
    expect(listApprovals(root, "pending")).toHaveLength(0);
    expect(listApprovals(root, "approved")).toHaveLength(1);
  });
});
