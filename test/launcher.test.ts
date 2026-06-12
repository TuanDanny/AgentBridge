import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  QUICK_TUNNEL_WARNING,
  createLauncherGreeting,
  launcherConfigPath,
  setupLauncher,
  validateLauncherConfig
} from "../src/launcher.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-launcher-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("one-click launcher helpers", () => {
  it("accepts HTTPS public URLs", () => {
    const root = makeTempRoot();
    const result = validateLauncherConfig(root, {
      projectId: "AgentBridge",
      publicBaseUrl: "https://codexlink.example.com/",
      gptUrl: "https://chatgpt.com/g/example"
    });
    expect(result.config.publicBaseUrl).toBe("https://codexlink.example.com");
    expect(result.config.gptUrl).toBe("https://chatgpt.com/g/example");
    expect(result.warnings).toEqual([]);
  });

  it("rejects invalid or insecure public URLs", () => {
    const root = makeTempRoot();
    expect(() => validateLauncherConfig(root, { publicBaseUrl: "not a url" })).toThrow(/valid URL/);
    expect(() => validateLauncherConfig(root, { publicBaseUrl: "http://codexlink.example.com" })).toThrow(/https/);
  });

  it("warns for trycloudflare quick tunnel URLs", () => {
    const root = makeTempRoot();
    const result = validateLauncherConfig(root, {
      publicBaseUrl: "https://temporary.trycloudflare.com"
    });
    expect(result.config.tunnelMode).toBe("quick");
    expect(result.warnings).toContain(QUICK_TUNNEL_WARNING);
  });

  it("creates a GPT greeting without token-like content or mojibake", () => {
    const greeting = createLauncherGreeting();
    expect(greeting).toContain("Xin chào CodexLink");
    expect(greeting).toContain("Không đọc repo nếu chưa cần.");
    expect(greeting).not.toContain("Ã");
    expect(greeting).not.toContain("Ä");
    expect(greeting).not.toContain("local_token");
    expect(greeting).not.toContain("Bearer ");
    expect(greeting).not.toContain("OPENAI_API_KEY");
    expect(greeting).not.toContain("sk-");
  });

  it("setup launcher dry-run does not write runtime config", () => {
    const root = makeTempRoot();
    const result = setupLauncher(root, {
      dryRun: true,
      projectId: "AgentBridge",
      publicBaseUrl: "https://codexlink.example.com"
    });
    expect(result.ok).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(result.changed_files).toEqual([]);
    expect(fs.existsSync(launcherConfigPath(root))).toBe(false);
  });

  it("setup launcher writes local runtime config outside git scope when not dry-run", () => {
    const root = makeTempRoot();
    const result = setupLauncher(root, {
      projectId: "AgentBridge"
    });
    expect(result.ok).toBe(true);
    expect(result.changed_files).toEqual([".agentbridge/launcher-config.json"]);
    expect(fs.existsSync(launcherConfigPath(root))).toBe(true);
  });
});
