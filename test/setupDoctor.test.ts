import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseHttpStatus, diagnoseSetupIssue, runDoctor, setupCodexLauncher, setupCodexPlugin, setupRelay } from "../src/setupDoctor.js";
import { bindRelayPairingCode, createRelayPairing } from "../src/relayPairing.js";

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

  it("reports missing launcher config as WARN without failing doctor", async () => {
    const root = makeTempRoot();
    const result = await runDoctor(root, { projectId: "DoctorProject", launcher: true });
    const launcherConfig = result.checks.find((check) => check.name === "launcher_config");
    expect(result.ok).toBe(true);
    expect(launcherConfig).toMatchObject({ status: "WARN" });
    expect(JSON.stringify(result)).not.toContain("local_token");
    expect(JSON.stringify(result)).not.toContain("Bearer ");
  });

  it("reports trycloudflare launcher URLs as WARN", async () => {
    const root = makeTempRoot();
    const setup = setupCodexLauncher(root, {
      projectId: "DoctorProject",
      publicBaseUrl: "https://temporary.trycloudflare.com",
      gptUrl: "https://chatgpt.com/g/example"
    });
    expect(setup.ok).toBe(true);
    const result = await runDoctor(root, { projectId: "DoctorProject", launcher: true });
    const publicUrl = result.checks.find((check) => check.name === "launcher_public_url");
    const readiness = result.checks.find((check) => check.name === "launcher_one_click_readiness");
    expect(publicUrl).toMatchObject({ status: "WARN" });
    expect(readiness).toMatchObject({ status: "WARN" });
    expect(JSON.stringify(result)).not.toContain("local_token");
    expect(JSON.stringify(result)).not.toContain("Bearer ");
    expect(JSON.stringify(result)).not.toContain("OPENAI_API_KEY");
  });

  it("keeps relay setup as a safe placeholder", async () => {
    const root = makeTempRoot();
    const dryRun = setupRelay(root, { dryRun: true });
    expect(dryRun.ok).toBe(true);
    expect(dryRun.changed_files).toEqual([]);
    expect(JSON.stringify(dryRun)).not.toContain("local_token");
    expect(JSON.stringify(dryRun)).not.toContain("Bearer ");
    expect(JSON.stringify(dryRun)).not.toContain("OPENAI_API_KEY");

    const written = setupRelay(root);
    expect(written.changed_files).toEqual([".agentbridge/relay-config.json"]);
    const result = await runDoctor(root, { projectId: "DoctorProject", launcher: true });
    const relay = result.checks.find((check) => check.name === "relay_mode");
    expect(relay).toMatchObject({ status: "WARN" });
    expect(result.checks.find((check) => check.name === "relay_pairing")).toMatchObject({ status: "WARN" });
  });

  it("reports paired relay metadata without exposing a raw code", async () => {
    const root = makeTempRoot();
    const pairing = createRelayPairing(root, { ttlSeconds: 60 });
    bindRelayPairingCode(root, pairing.code, "gpt-session-doctor");

    const result = await runDoctor(root, { projectId: "DoctorProject", launcher: true });
    expect(result.checks.find((check) => check.name === "relay_pairing")).toMatchObject({ status: "PASS" });
    expect(JSON.stringify(result)).not.toContain(pairing.code);
    expect(JSON.stringify(result)).not.toContain("local_token");
    expect(JSON.stringify(result)).not.toContain("Bearer ");
  });

  it("validates a stable hosted relay schema URL", async () => {
    const root = makeTempRoot();
    let origin = "";
    const server = http.createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/relay/health") {
        response.end(JSON.stringify({ ok: true, status: "hosted_mvp", schema_ready: true }));
        return;
      }
      if (request.url === "/relay/openapi.json") {
        response.end(JSON.stringify({ openapi: "3.1.0", servers: [{ url: origin }], paths: { "/relay/pair": {} } }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ ok: false }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    origin = `http://127.0.0.1:${port}`;
    try {
      setupCodexLauncher(root, {
        projectId: "DoctorProject",
        tunnelMode: "relay",
        relayUrl: origin,
        relayAllRegistered: true
      });
      const result = await runDoctor(root, { projectId: "DoctorProject", launcher: true });
      expect(result.checks.find((check) => check.name === "launcher_relay_health")).toMatchObject({ status: "PASS" });
      expect(result.checks.find((check) => check.name === "launcher_relay_schema")).toMatchObject({ status: "PASS" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
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
