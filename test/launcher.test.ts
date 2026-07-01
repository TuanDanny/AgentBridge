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
      tunnelMode: "relay",
      relayHost: "127.0.0.1",
      relayPort: 8787
    });
    expect(result.config.tunnelMode).toBe("relay");
    expect(result.config.relayHost).toBe("127.0.0.1");
    expect(result.config.relayPort).toBe(8787);
    expect(result.config.autoRelay).toBe(true);
    expect(result.warnings).toContain(RELAY_MODE_WARNING);
    expect(() => validateLauncherConfig(root, { tunnelMode: "relay", relayHost: "0.0.0.0" })).toThrow(/loopback/);
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
    expect(result.next_steps).toContain("Pair GPT Actions with the short-lived code printed by the relay client.");
    expect(result.next_steps).toContain(
      "The launcher can auto-start the loopback relay prototype at http://127.0.0.1:8787."
    );
  });

  it("supports either explicit relay projects or all registered projects", () => {
    const root = makeTempRoot();
    const explicit = validateLauncherConfig(root, {
      projectId: "AgentBridge",
      tunnelMode: "relay",
      relayUrl: "https://relay.example.com",
      relayProjects: ["AgentBridge", "SecondProject", "agentbridge"]
    });
    expect(explicit.config.relayProjects).toEqual(["AgentBridge", "SecondProject"]);
    expect(explicit.config.relayAllRegistered).toBe(false);

    const all = setupLauncher(root, {
      dryRun: true,
      projectId: "AgentBridge",
      tunnelMode: "relay",
      relayUrl: "https://relay.example.com",
      relayAllRegistered: true
    });
    expect(all.config.relayAllRegistered).toBe(true);
    expect(all.next_steps).toContain("The relay client exposes all explicitly registered project IDs.");
    expect(() =>
      validateLauncherConfig(root, {
        relayAllRegistered: true,
        relayProjects: ["AgentBridge"]
      })
    ).toThrow(/not both/);
  });

  it("ships first-time and daily launcher scripts without release or token actions", () => {
    const repoRoot = process.cwd();
    const restoreScript = fs.readFileSync(path.join(repoRoot, "restore-ngrok-setup.bat"), "utf8");
    const startPowerShell = fs.readFileSync(path.join(repoRoot, "scripts", "start-codexlink.ps1"), "utf8");
    const stopPowerShell = fs.readFileSync(path.join(repoRoot, "scripts", "stop-codexlink.ps1"), "utf8");
    const relaySmoke = fs.readFileSync(path.join(repoRoot, "scripts", "smoke-v12-relay-loopback.ps1"), "utf8");
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

    expect(restoreScript).toContain("AgentBridge ngrok Restore Setup");
    expect(restoreScript).toContain("taskkill /f /im node.exe");
    expect(startPowerShell).toContain("$psi.Arguments =");
    expect(startPowerShell).not.toContain("ArgumentList.Add");
    expect(startPowerShell).toContain('"doctor","--launcher","--project",$Config.projectId');
    expect(startPowerShell).toContain("Relay GPT Actions schema: openapi.codexlink.relay.gpt-actions.json");
    expect(startPowerShell).toContain("Relay prototype: PASS");
    expect(startPowerShell).toContain('"relay","serve","--experimental","--host",$Config.relayHost');
    expect(startPowerShell).toContain('"relay","pairing","create","--json"');
    expect(startPowerShell).toContain('"relay","client","connect","--relay-url",$RelayUrl');
    expect(startPowerShell).toContain("--use-local-pairing");
    expect(startPowerShell).toContain("--all-registered");
    expect(startPowerShell).toContain("relayProjects");
    expect(startPowerShell).toContain("Say-ConsoleOnly \"Relay pairing code:");
    expect(startPowerShell).toContain("Relay mode note: use the relay GPT Actions schema only with a trusted relay origin.");
    expect(stopPowerShell).toContain("relay_process_id");
    expect(stopPowerShell).toContain("relay_client_process_id");
    expect(stopPowerShell).toContain("Relay prototype stopped");
    expect(stopPowerShell).toContain("Relay client stopped");
    expect(relaySmoke).toContain("/relay/pair");
    expect(relaySmoke).toContain("/chatgpt/projects/$ProjectId/session/summary");
    expect(relaySmoke).toContain("OKKK");

    expect(relaySmoke).not.toMatch(/\bBearer\s+[A-Za-z0-9_=-]{8,}/);
    expect(relaySmoke).not.toMatch(/\bOPENAI_API_KEY\s*=\s*sk-/);
    expect(relaySmoke).not.toMatch(/\bsk-[A-Za-z0-9_=-]{8,}/);

    const combined = `${restoreScript}\n${startPowerShell}\n${stopPowerShell}`;
    expect(combined).not.toMatch(/\.agentbridge[\\/]local_token/i);
    expect(combined).not.toMatch(/\bBearer\b/);
    expect(combined).not.toMatch(/\bOPENAI_API_KEY\b/);
    expect(combined).not.toMatch(/\bsk-[A-Za-z0-9_=-]{8,}/);
    expect(combined).not.toMatch(/\bgit\s+push\b/i);
    expect(combined).not.toMatch(/\bgit\s+tag\b/i);
    expect(combined).not.toMatch(/\bgh\s+release\b/i);
    expect(combined).not.toMatch(/\bnpm\s+publish\b/i);

    expect(packageJson.files).toEqual(
      expect.arrayContaining(["restore-ngrok-setup.bat", "run-gpt-action-setup.bat"])
    );
  });
});
