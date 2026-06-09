import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseHttpStatus, diagnoseSetupIssue, runDoctor, setupCodexPlugin } from "../src/setupDoctor.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-doctor-"));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "cli.js"), "#!/usr/bin/env node\n", "utf8");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        scripts: {
          build: "tsc -p tsconfig.json",
          test: "vitest run",
          "generate:openapi": "node scripts/generate-openapi.mjs"
        }
      },
      null,
      2
    ),
    "utf8"
  );
  fs.cpSync(path.resolve("plugins"), path.join(root, "plugins"), { recursive: true });
  fs.cpSync(path.resolve(".agents"), path.join(root, ".agents"), { recursive: true });
  fs.copyFileSync(path.resolve("openapi.agentbridge.json"), path.join(root, "openapi.agentbridge.json"));
  fs.copyFileSync(path.resolve("openapi.agentbridge.gpt-actions.json"), path.join(root, "openapi.agentbridge.gpt-actions.json"));
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("CodexLink setup doctor", () => {
  it("validates Codex plugin setup in dry-run mode", () => {
    const result = setupCodexPlugin(process.cwd(), { dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(result.changed_files).toEqual([]);
    expect(result.checks.map((check) => check.name)).toEqual(expect.arrayContaining(["plugin_json", "mcp_json", "hooks_json", "marketplace_json"]));
    expect(JSON.stringify(result)).not.toContain(".agentbridge/local_token");
    expect(JSON.stringify(result)).not.toContain("Bearer ");
    expect(JSON.stringify(result)).not.toContain("OPENAI_API_KEY");
  });

  it("reports missing optional tunnel as WARN without failing doctor", async () => {
    const root = makeTempRoot();
    const result = await runDoctor(root, { projectId: "DoctorProject" });
    const tunnel = result.checks.find((check) => check.name === "tunnel_health");
    const names = result.checks.map((check) => check.name);
    expect(result.ok).toBe(true);
    expect(tunnel).toMatchObject({
      status: "WARN"
    });
    expect(tunnel?.message).toContain("No remote_bridge");
    expect(names).toEqual(
      expect.arrayContaining([
        "recent_activity",
        "activity_freshness",
        "workspace_snapshot_health",
        "summary_compactness",
        "runtime_raw_content_scan"
      ])
    );
    expect(result.checks.find((check) => check.name === "summary_compactness")?.status).toBe("PASS");
    expect(result.checks.find((check) => check.name === "runtime_raw_content_scan")?.status).toBe("PASS");
  });

  it("diagnoses common setup failures with actionable messages", () => {
    expect(diagnoseHttpStatus(502)).toContain("Local AgentBridge server");
    expect(diagnoseHttpStatus(530)).toContain("quick tunnel");
    expect(diagnoseSetupIssue("ClientResponseError")).toContain("GPT Actions");
    expect(diagnoseSetupIssue("server_not_running")).toContain("not running");
    expect(diagnoseSetupIssue("mcp_plugin_missing")).toContain("MCP/plugin");
    expect(diagnoseSetupIssue("schema_missing_request_body")).toContain("requestBody");
    expect(diagnoseSetupIssue("hook_not_trusted")).toContain("trust");
  });
});
