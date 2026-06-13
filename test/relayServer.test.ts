import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRelayPairing } from "../src/relayPairing.js";
import { startRelayPrototypeServer, type RunningRelayPrototypeServer } from "../src/relayServer.js";
import { registerCurrentProject } from "../src/registry.js";
import { bootstrapSession } from "../src/sessionStore.js";

const tempRoots: string[] = [];
const runningServers: RunningRelayPrototypeServer[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-relay-server-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const running of runningServers.splice(0)) {
    await running.close().catch(() => undefined);
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("relay prototype server", () => {
  it("serves health publicly and protects metadata dispatch with pairing", async () => {
    const root = makeTempRoot();
    registerCurrentProject(root, "RelayServer");
    bootstrapSession(root, "RelayServer", { actor: "codex", client: "codex", adapter: "cli", source: "relay_server_test" });
    const pairing = createRelayPairing(root, { ttlSeconds: 60 });
    const running = await startRelayPrototypeServer(root, { port: 0 });
    runningServers.push(running);

    const health = await relayJson({ port: running.info.port, path: "/relay/health" });
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ ok: true, experimental: true, local_only: true });

    const denied = await relayJson({ port: running.info.port, path: "/chatgpt/projects" });
    expect(denied.status).toBe(401);

    const mcp = await relayJson({ port: running.info.port, path: "/mcp" });
    expect(mcp.status).toBe(404);

    const paired = await relayJson({
      port: running.info.port,
      path: "/relay/pair",
      method: "POST",
      body: { code: pairing.code, gpt_session: "gpt-session-relay-server" }
    });
    expect(paired.status).toBe(200);
    expect(JSON.stringify(paired.body)).not.toContain(pairing.code);

    const projects = await relayJson({
      port: running.info.port,
      path: "/chatgpt/projects",
      relaySession: "gpt-session-relay-server"
    });
    expect(projects.status).toBe(200);
    expect(projects.body).toMatchObject({ ok: true, operation_id: "listProjects" });
    expect(JSON.stringify(projects.body)).not.toContain(root);
    expect(JSON.stringify(projects.body)).not.toContain("local_token");
    expect(JSON.stringify(projects.body)).not.toContain("Bearer ");

    const summary = await relayJson({
      port: running.info.port,
      path: "/chatgpt/projects/RelayServer/session/summary",
      relaySession: "gpt-session-relay-server"
    });
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({ ok: true, operation_id: "getSessionSummary" });
    expect(summary.body.metadata).toMatchObject({ validated: true, local_only: true, content_stored: false });
  });

  it("rejects non-loopback bind hosts", async () => {
    await expect(startRelayPrototypeServer(makeTempRoot(), { host: "0.0.0.0", port: 0 })).rejects.toThrow(/loopback/);
  });
});

function relayJson(input: {
  port: number;
  path: string;
  method?: string;
  body?: unknown;
  relaySession?: string;
}): Promise<{ status: number; body: any }> {
  const payload = input.body === undefined ? undefined : JSON.stringify(input.body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: input.port,
        path: input.path,
        method: input.method ?? "GET",
        headers: {
          ...(input.relaySession ? { "X-CodexLink-Relay-Session": input.relaySession } : {}),
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {})
        }
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} });
        });
      }
    );
    request.on("error", reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}
