import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureLocalToken } from "../src/auth.js";
import { readJsonIfExists } from "../src/fsx.js";
import {
  formatTunnelTestResult,
  registerTunnel,
  testTunnel,
  tunnelGuide,
  tunnelStatus,
  type RemoteBridgeInfo
} from "../src/tunnel.js";

const tempRoots: string[] = [];
const servers: http.Server[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-tunnel-"));
  tempRoots.push(root);
  return root;
}

function bridgeFile(root: string, name: string): string {
  return path.join(root, ".agentbridge", name);
}

function startFakeBridge(token: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    const send = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body);
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      });
      response.end(payload);
    };

    const authorized = request.headers.authorization === `Bearer ${token}`;

    if (request.method === "GET" && request.url === "/health") {
      send(200, { ok: true });
      return;
    }

    if (!authorized) {
      send(401, { ok: false, error: "Unauthorized." });
      return;
    }

    if (request.method === "GET" && request.url === "/chatgpt/session-summary") {
      send(200, { ok: true, session: { project_name: "fake" } });
      return;
    }

    if (request.method === "GET" && request.url === "/chatgpt/repo-status") {
      send(200, { ok: true, available: true, branch: "main", changed_files: [] });
      return;
    }

    if (request.method === "POST" && request.url === "/chatgpt/classify-command") {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        send(200, {
          ok: true,
          risk: body.command === "rm -rf node_modules" ? "high" : "low",
          reasons: ["Recursive force delete.", "Delete command."],
          requiresApproval: true,
          blocked: body.command === "rm -rf node_modules"
        });
      });
      return;
    }

    send(404, { ok: false, error: "Not found." });
  });

  servers.push(server);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address !== "object") {
        reject(new Error("Fake server did not bind to a TCP port."));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) {
                closeReject(error);
                return;
              }
              closeResolve();
            });
          })
      });
    });
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    }).catch(() => undefined);
  }

  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("secure tunnel bridge", () => {
  it("prints a guide with daemon, cloudflared, ngrok, register, and test steps", () => {
    const guide = tunnelGuide();

    expect(guide).toContain("agentbridge start --host 127.0.0.1 --port 7777");
    expect(guide).toContain("cloudflared tunnel --url http://127.0.0.1:7777");
    expect(guide).toContain("ngrok http 7777");
    expect(guide).toContain("agentbridge tunnel register");
    expect(guide).toContain("agentbridge tunnel test");
  });

  it("registers https URLs and does not write the local token", () => {
    const root = makeTempRoot();
    const token = ensureLocalToken(root);

    const result = registerTunnel(root, "https://example.trycloudflare.com/");
    const info = readJsonIfExists<RemoteBridgeInfo>(bridgeFile(root, "remote_bridge.json"));

    expect(result.changedFiles).toContain("remote_bridge.json");
    expect(info?.public_url).toBe("https://example.trycloudflare.com");
    expect(info?.local_url).toBe("http://127.0.0.1:7777");
    expect(JSON.stringify(info)).not.toContain(token);
  });

  it("rejects http URLs unless --allow-insecure is explicit", () => {
    const root = makeTempRoot();

    expect(() => registerTunnel(root, "http://example.com")).toThrow(/https/);

    registerTunnel(root, "http://127.0.0.1:7777", { allowInsecure: true });
    const info = readJsonIfExists<RemoteBridgeInfo>(bridgeFile(root, "remote_bridge.json"));
    expect(info?.public_url).toBe("http://127.0.0.1:7777");
    expect(info?.allow_insecure).toBe(true);
  });

  it("prints tunnel status without the full token", () => {
    const root = makeTempRoot();
    const token = ensureLocalToken(root);
    registerTunnel(root, "https://example.trycloudflare.com");

    const status = tunnelStatus(root);

    expect(status).toContain("Public URL: https://example.trycloudflare.com");
    expect(status).toContain("Token exists: yes");
    expect(status).toContain("Token value: hidden");
    expect(status).not.toContain(token);
  });

  it("tests a registered tunnel against health, auth, repo, and command safety endpoints", async () => {
    const root = makeTempRoot();
    const token = ensureLocalToken(root);
    const fake = await startFakeBridge(token);
    registerTunnel(root, fake.url, { allowInsecure: true });

    const result = await testTunnel(root);
    const formatted = formatTunnelTestResult(result);

    expect(result.ok).toBe(true);
    expect(result.checks.map((item) => item.status)).toEqual(["pass", "pass", "pass", "pass", "pass"]);
    expect(formatted).toContain("Overall: PASS");
    expect(formatted).toContain("blocks rm -rf node_modules");
  });
});
