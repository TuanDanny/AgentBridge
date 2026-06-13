import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  QUICK_TUNNEL_WARNING,
  RELAY_MODE_WARNING,
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

  it("allows relay mode only as an experimental warning", () => {
    const root = makeTempRoot();
    const result = validateLauncherConfig(root, {
      tunnelMode: "relay"
    });
    expect(result.config.tunnelMode).toBe("relay");
    expect(result.warnings).toContain(RELAY_MODE_WARNING);
  });

  it("creates a GPT greeting without token-like content or mojibake", () => {
    const greeting = createLauncherGreeting();
    expect(greeting).toContain("Xin chao CodexLink");
    expect(greeting).toContain("Khong doc repo neu chua can.");
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

  it("setup launcher gives concrete relay-mode next steps", () => {
    const root = makeTempRoot();
    const result = setupLauncher(root, {
      dryRun: true,
      projectId: "AgentBridge",
      tunnelMode: "relay"
    });
    expect(result.warnings).toContain(RELAY_MODE_WARNING);
    expect(result.next_steps).toContain(
      "Import openapi.codexlink.relay.gpt-actions.json only when using a trusted relay origin."
    );
    expect(result.next_steps).toContain("Use node dist/cli.js relay pairing create to create a short-lived pairing code.");
    expect(result.next_steps).toContain(
      "For local prototype testing only, run node dist/cli.js relay serve --experimental."
    );
  });

  it("ships first-time and daily launcher scripts without release or token actions", () => {
    const repoRoot = process.cwd();
    const firstTimeScript = fs.readFileSync(path.join(repoRoot, "setup-codexlink-first-time.bat"), "utf8");
    const startScript = fs.readFileSync(path.join(repoRoot, "start-codexlink.bat"), "utf8");
    const startPowerShell = fs.readFileSync(path.join(repoRoot, "scripts", "start-codexlink.ps1"), "utf8");
    const stopScript = fs.readFileSync(path.join(repoRoot, "stop-codexlink.bat"), "utf8");
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

    expect(firstTimeScript).toContain("CodexLink First-Time Setup");
    expect(firstTimeScript).toContain("call npm install <nul");
    expect(firstTimeScript).toContain("call npm run build <nul");
    expect(firstTimeScript).toContain("--defaults   Use safe defaults");
    expect(firstTimeScript).toContain("--no-start   Do not start CodexLink after setup.");
    expect(firstTimeScript).toContain("Defaults mode: skipping git pull.");
    expect(firstTimeScript).toContain('project register-current "%PROJECT_ID%" <nul');
    expect(firstTimeScript).toContain('setup launcher --project "%PROJECT_ID%" <nul');
    expect(firstTimeScript).toContain('doctor --launcher --project "%PROJECT_ID%" --json <nul');
    expect(firstTimeScript).toContain("Start skipped by --no-start.");
    expect(firstTimeScript).toContain("Non-interactive defaults mode complete.");
    expect(firstTimeScript).toContain("Start CodexLink now? [Y/n]");
    expect(startPowerShell).toContain("$psi.Arguments =");
    expect(startPowerShell).not.toContain("ArgumentList.Add");
    expect(startPowerShell).toContain('"doctor","--launcher","--project",$Config.projectId');
    expect(startPowerShell).toContain("Relay GPT Actions schema: openapi.codexlink.relay.gpt-actions.json");
    expect(startPowerShell).toContain('"relay","pairing","create","--json"');
    expect(startPowerShell).toContain("Say-ConsoleOnly \"Relay pairing code:");
    expect(startPowerShell).toContain("Relay mode note: use the relay GPT Actions schema only with a trusted relay origin.");
    expect(startScript).toContain("scripts\\start-codexlink.ps1");
    expect(stopScript).toContain("scripts\\stop-codexlink.ps1");

    const combined = `${firstTimeScript}\n${startScript}\n${stopScript}`;
    expect(combined).not.toMatch(/\.agentbridge[\\/]local_token/i);
    expect(combined).not.toMatch(/\bBearer\b/);
    expect(combined).not.toMatch(/\bOPENAI_API_KEY\b/);
    expect(combined).not.toMatch(/\bsk-[A-Za-z0-9_=-]{8,}/);
    expect(combined).not.toMatch(/\bgit\s+push\b/i);
    expect(combined).not.toMatch(/\bgit\s+tag\b/i);
    expect(combined).not.toMatch(/\bgh\s+release\b/i);
    expect(combined).not.toMatch(/\bnpm\s+publish\b/i);

    expect(packageJson.files).toEqual(
      expect.arrayContaining(["setup-codexlink-first-time.bat", "start-codexlink.bat", "stop-codexlink.bat"])
    );
  });
});
