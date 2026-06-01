import http from "node:http";
import https from "node:https";
import { readLocalToken } from "./auth.js";
import { pathExists, readJsonIfExists, readTextIfExists, writeJson } from "./fsx.js";
import { bridgePath, getBridgeDir, resolveProjectRoot } from "./paths.js";
import { appendAudit, ensureProjectScaffold } from "./session.js";
import type { CommandResult, ServerInfo } from "./types.js";

export interface RemoteBridgeInfo {
  public_url: string;
  local_url: string;
  created_at: string;
  security_note: string;
  allow_insecure?: boolean;
}

export interface TunnelTestItem {
  name: string;
  status: "pass" | "fail";
  detail: string;
}

export interface TunnelTestResult {
  ok: boolean;
  public_url: string;
  checks: TunnelTestItem[];
}

function remoteBridgePath(root: string): string {
  return bridgePath(root, "remote_bridge.json");
}

function normalizePublicUrl(input: string, allowInsecure = false): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Tunnel public URL must be a valid URL.");
  }

  if (url.protocol === "http:" && !allowInsecure) {
    throw new Error("Tunnel public URL must use https:// unless --allow-insecure is set.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Tunnel public URL must use https://.");
  }

  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function readLocalUrl(root: string): string {
  const serverInfo = readJsonIfExists<ServerInfo>(bridgePath(root, "server.json"));
  if (serverInfo) {
    return `http://${serverInfo.host}:${serverInfo.port}`;
  }

  return "http://127.0.0.1:7777";
}

function readRemoteBridge(root: string): RemoteBridgeInfo {
  const info = readJsonIfExists<RemoteBridgeInfo>(remoteBridgePath(root));
  if (!info) {
    throw new Error("No tunnel registered. Run `agentbridge tunnel register <public-url>` first.");
  }
  return info;
}

function joinUrl(base: string, pathname: string): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${pathname.replace(/^\//, "")}`;
  return url.toString();
}

function requestRemoteJson<T = unknown>(input: {
  url: string;
  method?: string;
  token?: string;
  body?: unknown;
  timeoutMs?: number;
}): Promise<{ status: number; body: T | undefined }> {
  const url = new URL(input.url);
  const payload = input.body === undefined ? undefined : JSON.stringify(input.body);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: input.method ?? "GET",
        timeout: input.timeoutMs ?? 5000,
        headers: {
          ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
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
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: raw ? (JSON.parse(raw) as T) : undefined
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("Tunnel request timed out."));
    });
    request.on("error", reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

function check(name: string, passed: boolean, detail: string): TunnelTestItem {
  return {
    name,
    status: passed ? "pass" : "fail",
    detail
  };
}

export function tunnelGuide(): string {
  return `AgentBridge Secure Tunnel Bridge

1. Start the local daemon:
   agentbridge start --host 127.0.0.1 --port 7777

2. Start a user-managed HTTPS tunnel:
   cloudflared tunnel --url http://127.0.0.1:7777
   or
   ngrok http 7777

3. Register the public HTTPS URL:
   agentbridge tunnel register https://your-url.example

4. Test the tunnel:
   agentbridge tunnel test

Security:
- Keep .agentbridge/local_token private.
- Do not paste the token into group chat, issue trackers, docs, or logs.
- Keep /chatgpt/* token-protected.
- This is not cloud/team mode and does not use API keys.
`;
}

export function registerTunnel(
  rootInput = process.cwd(),
  publicUrl: string,
  options: { allowInsecure?: boolean; localUrl?: string } = {}
): CommandResult {
  const root = resolveProjectRoot(rootInput);
  ensureProjectScaffold(root);

  const normalizedUrl = normalizePublicUrl(publicUrl, options.allowInsecure);
  const info: RemoteBridgeInfo = {
    public_url: normalizedUrl,
    local_url: options.localUrl ?? readLocalUrl(root),
    created_at: new Date().toISOString(),
    security_note: "Do not share your local token publicly.",
    ...(options.allowInsecure ? { allow_insecure: true } : {})
  };

  writeJson(remoteBridgePath(root), info);
  appendAudit(root, "tunnel.register", {
    public_url: normalizedUrl,
    local_url: info.local_url,
    allow_insecure: Boolean(options.allowInsecure)
  });

  return {
    bridgeDir: getBridgeDir(root),
    message: `Registered tunnel URL: ${normalizedUrl}`,
    changedFiles: ["remote_bridge.json", "audit.jsonl"]
  };
}

export function tunnelStatus(rootInput = process.cwd()): string {
  const root = resolveProjectRoot(rootInput);
  ensureProjectScaffold(root);
  const tokenExists = readTextIfExists(bridgePath(root, "local_token")).trim().length > 0;

  if (!pathExists(remoteBridgePath(root))) {
    return `Secure Tunnel Bridge Status

Registered: no
Token exists: ${tokenExists ? "yes" : "no"}
Token value: hidden
Next step: agentbridge tunnel register https://your-url.example
Security note: Do not expose .agentbridge/local_token publicly.
`;
  }

  const info = readRemoteBridge(root);
  return `Secure Tunnel Bridge Status

Registered: yes
Public URL: ${info.public_url}
Local URL: ${info.local_url}
Token exists: ${tokenExists ? "yes" : "no"}
Token value: hidden
Security note: ${info.security_note}
Warning: Anyone with both the tunnel URL and local token can access protected AgentBridge endpoints.
`;
}

export async function testTunnel(rootInput = process.cwd()): Promise<TunnelTestResult> {
  const root = resolveProjectRoot(rootInput);
  ensureProjectScaffold(root);
  const info = readRemoteBridge(root);
  const token = readLocalToken(root);
  if (!token) {
    throw new Error("Local token not found. Start the daemon once or run `agentbridge start` before tunnel testing.");
  }

  const checks: TunnelTestItem[] = [];

  const health = await requestRemoteJson<{ ok?: boolean }>({
    url: joinUrl(info.public_url, "/health")
  });
  checks.push(check("GET /health", health.status === 200 && health.body?.ok === true, `status ${health.status}`));

  const unauthorized = await requestRemoteJson({
    url: joinUrl(info.public_url, "/chatgpt/session-summary")
  });
  checks.push(
    check(
      "GET /chatgpt/session-summary without token",
      unauthorized.status === 401,
      `status ${unauthorized.status}`
    )
  );

  const session = await requestRemoteJson<{ ok?: boolean }>({
    url: joinUrl(info.public_url, "/chatgpt/session-summary"),
    token
  });
  checks.push(
    check("GET /chatgpt/session-summary with token", session.status === 200 && session.body?.ok === true, `status ${session.status}`)
  );

  const repo = await requestRemoteJson<{ ok?: boolean }>({
    url: joinUrl(info.public_url, "/chatgpt/repo-status"),
    token
  });
  checks.push(check("GET /chatgpt/repo-status with token", repo.status === 200 && repo.body?.ok === true, `status ${repo.status}`));

  const classified = await requestRemoteJson<{ ok?: boolean; risk?: string; blocked?: boolean }>({
    url: joinUrl(info.public_url, "/chatgpt/classify-command"),
    method: "POST",
    token,
    body: { command: "rm -rf node_modules" }
  });
  checks.push(
    check(
      "POST /chatgpt/classify-command blocks rm -rf node_modules",
      classified.status === 200 && classified.body?.risk === "high" && classified.body?.blocked === true,
      `status ${classified.status}, risk ${classified.body?.risk ?? "unknown"}, blocked ${String(classified.body?.blocked)}`
    )
  );

  const ok = checks.every((item) => item.status === "pass");
  appendAudit(root, "tunnel.test", {
    public_url: info.public_url,
    ok,
    checks: checks.map((item) => ({ name: item.name, status: item.status }))
  });

  return {
    ok,
    public_url: info.public_url,
    checks
  };
}

export function formatTunnelTestResult(result: TunnelTestResult): string {
  const lines = result.checks.map((item) => `- [${item.status === "pass" ? "x" : " "}] ${item.name}: ${item.status.toUpperCase()} (${item.detail})`);
  return `Secure Tunnel Bridge Test

Public URL: ${result.public_url}
Overall: ${result.ok ? "PASS" : "FAIL"}

${lines.join("\n")}
`;
}
