import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRelayPairing } from "../src/relayPairing.js";
import { startRelayClient, type RunningRelayClient } from "../src/relayClient.js";
import { startHostedRelayServer, type RunningHostedRelayServer } from "../src/relayHostedServer.js";
import { startRelayPrototypeServer, type RunningRelayPrototypeServer } from "../src/relayServer.js";
import { registerCurrentProject, registerProject } from "../src/registry.js";
import { bootstrapSession } from "../src/sessionStore.js";

const tempRoots: string[] = [];
const runningServers: RunningRelayPrototypeServer[] = [];
const runningHostedServers: RunningHostedRelayServer[] = [];
const runningClients: RunningRelayClient[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-relay-server-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const client of runningClients.splice(0)) {
    await client.close().catch(() => undefined);
  }
  for (const running of runningHostedServers.splice(0)) {
    await running.close().catch(() => undefined);
  }
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

  it("forwards paired hosted relay metadata and inspector requests over WebSocket", async () => {
    const root = makeTempRoot();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "hosted-relay-fixture" }, null, 2));
    fs.writeFileSync(path.join(root, "README.md"), "# Hosted Relay Fixture\n\nsessionStore relay marker\n");
    const otherRoot = path.join(root, "other");
    fs.mkdirSync(otherRoot);
    fs.writeFileSync(path.join(otherRoot, "README.md"), "other project should not be relay-visible\n");
    registerCurrentProject(root, "HostedRelay");
    registerProject(root, "OtherProject", otherRoot);
    bootstrapSession(root, "HostedRelay", { actor: "codex", client: "codex", adapter: "cli", source: "hosted_relay_test" });

    const hosted = await startHostedRelayServer({ host: "127.0.0.1", port: 0, publicUrl: "https://relay.codexlink.example.com" });
    runningHostedServers.push(hosted);
    const relayUrl = `http://127.0.0.1:${hosted.info.port}`;
    const client = await startRelayClient({ root, relayUrl, projectId: "HostedRelay", ttlSeconds: 60 });
    runningClients.push(client);

    const unpaired = await relayJson({ port: hosted.info.port, path: "/chatgpt/projects" });
    expect(unpaired.status).toBe(401);

    const mcp = await relayJson({ port: hosted.info.port, path: "/mcp" });
    expect(mcp.status).toBe(404);

    const badPair = await relayJson({
      port: hosted.info.port,
      path: "/relay/pair",
      method: "POST",
      body: { code: "BAD-CODE", gpt_session: "gpt-hosted-relay-test" }
    });
    expect(badPair.status).toBe(401);

    const paired = await relayJson({
      port: hosted.info.port,
      path: "/relay/pair",
      method: "POST",
      body: { code: client.pairing_code, gpt_session: "gpt-hosted-relay-test" }
    });
    expect(paired.status).toBe(200);
    expect(JSON.stringify(paired.body)).not.toContain(client.pairing_code);
    const relaySession = paired.body.relay_session as string;
    expect(relaySession).toMatch(/^relay_sess_/);

    const wrongSession = await relayJson({ port: hosted.info.port, path: "/chatgpt/projects", relaySession: "relay_sess_wrong" });
    expect(wrongSession.status).toBe(401);

    const projects = await relayJson({ port: hosted.info.port, path: "/chatgpt/projects", relaySession });
    const summary = await relayJson({ port: hosted.info.port, path: "/chatgpt/projects/HostedRelay/session/summary", relaySession });
    const context = await relayJson({ port: hosted.info.port, path: "/chatgpt/projects/HostedRelay/session/context", relaySession });
    const timeline = await relayJson({ port: hosted.info.port, path: "/chatgpt/projects/HostedRelay/session/timeline?limit=5", relaySession });
    const inspect = await relayJson({ port: hosted.info.port, path: "/chatgpt/projects/HostedRelay/inspect", relaySession });
    const tree = await relayJson({ port: hosted.info.port, path: "/chatgpt/projects/HostedRelay/tree?max_entries=20", relaySession });
    const files = await relayJson({ port: hosted.info.port, path: "/chatgpt/projects/HostedRelay/files/search?q=README", relaySession });
    const read = await relayJson({ port: hosted.info.port, path: "/chatgpt/projects/HostedRelay/file?path=README.md&max_chars=200", relaySession });
    const grep = await relayJson({ port: hosted.info.port, path: "/chatgpt/projects/HostedRelay/grep?q=sessionStore&max_matches=5", relaySession });

    for (const response of [projects, summary, context, timeline, inspect, tree, files, read, grep]) {
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ ok: true });
      expect(JSON.stringify(response.body)).not.toContain(root);
      expect(JSON.stringify(response.body)).not.toContain("local_token");
      expect(JSON.stringify(response.body)).not.toContain("Bearer ");
    }
    expect(JSON.stringify(tree.body)).toContain("recommended_next_reads");
    expect(JSON.stringify(projects.body)).toContain("HostedRelay");
    expect(JSON.stringify(projects.body)).not.toContain("OtherProject");
    expect(JSON.stringify(files.body)).toContain("README.md");
    expect(JSON.stringify(read.body)).toContain("Hosted Relay Fixture");
    expect(JSON.stringify(grep.body)).toContain("sessionStore");

    const unknown = await relayJson({ port: hosted.info.port, path: "/chatgpt/projects/Nope/inspect", relaySession });
    expect(unknown.status).toBe(404);
    const notAllowed = await relayJson({ port: hosted.info.port, path: "/chatgpt/projects/OtherProject/inspect", relaySession });
    expect(notAllowed.status).toBe(404);
  });

  it("requires HTTPS public URLs for hosted relay metadata", async () => {
    await expect(startHostedRelayServer({ host: "127.0.0.1", port: 0, publicUrl: "http://relay.codexlink.example.com" })).rejects.toThrow(/https/);
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
