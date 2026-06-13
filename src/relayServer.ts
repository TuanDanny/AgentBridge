import http from "node:http";
import { URL } from "node:url";
import { dispatchRelayRequestLocally } from "./relayLocalDispatch.js";
import { bindRelayPairingCode, readRelayPairingStatus } from "./relayPairing.js";
import { type RelayRequestEnvelope } from "./relayProtocol.js";
import { resolveProjectRoot } from "./paths.js";

export interface RunningRelayPrototypeServer {
  server: http.Server;
  info: {
    host: string;
    port: number;
    root: string;
    experimental: true;
  };
  close: () => Promise<void>;
}

export interface RelayPrototypeOptions {
  host?: string;
  port?: number;
}

export async function startRelayPrototypeServer(rootInput = process.cwd(), options: RelayPrototypeOptions = {}): Promise<RunningRelayPrototypeServer> {
  const root = resolveProjectRoot(rootInput);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  assertLoopbackHost(host);
  const startedAt = new Date().toISOString();

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    try {
      if (request.method === "GET" && url.pathname === "/relay/health") {
        sendJson(response, 200, {
          ok: true,
          name: "codexlink-relay-prototype",
          experimental: true,
          local_only: true,
          started_at: startedAt
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/relay/pair") {
        const body = await readRequestBody(request);
        const code = stringField(body, "code");
        const sessionHint = stringField(body, "gpt_session") ?? stringField(body, "gpt_session_hint");
        if (!code || !sessionHint) {
          sendJson(response, 400, { ok: false, error: { code: "invalid_pairing_request", message: "code and gpt_session are required." } });
          return;
        }
        const paired = bindRelayPairingCode(root, code, sessionHint);
        sendJson(response, paired.ok ? 200 : 401, paired);
        return;
      }

      if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
        sendJson(response, 404, { ok: false, error: { code: "not_found", message: "Relay prototype does not expose MCP." } });
        return;
      }

      if (!isRelaySessionAuthorized(root, request)) {
        sendJson(response, 401, { ok: false, error: { code: "relay_session_required", message: "Pair the relay first and send X-CodexLink-Relay-Session." } });
        return;
      }

      const envelope = relayEnvelopeFromRequest(request.method ?? "GET", url);
      if (!envelope) {
        sendJson(response, 404, { ok: false, error: { code: "not_found", message: "Relay route is not allowlisted." } });
        return;
      }
      const result = dispatchRelayRequestLocally(root, envelope);
      sendJson(response, result.status, result);
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: {
          code: "relay_prototype_error",
          message: error instanceof Error ? error.message : "Relay prototype error."
        }
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    info: {
      host,
      port: boundPort,
      root,
      experimental: true
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

function relayEnvelopeFromRequest(method: string, url: URL): RelayRequestEnvelope | undefined {
  if (method !== "GET") {
    return undefined;
  }
  if (url.pathname === "/chatgpt/projects") {
    return { operation_id: "listProjects", method: "GET", path: url.pathname };
  }
  const match = /^\/chatgpt\/projects\/([^/]+)\/session\/(summary|context|timeline)$/.exec(url.pathname);
  if (!match) {
    return undefined;
  }
  const [, projectId, kind] = match;
  const operationId =
    kind === "summary" ? "getSessionSummary" : kind === "context" ? "getSessionContext" : "getSessionTimeline";
  const body =
    kind === "timeline"
      ? {
          mode: url.searchParams.get("mode") ?? undefined,
          handoff_id: url.searchParams.get("handoff_id") ?? undefined,
          file_path: url.searchParams.get("file_path") ?? undefined,
          task_id: url.searchParams.get("task_id") ?? undefined,
          limit: url.searchParams.get("limit") ? Number.parseInt(url.searchParams.get("limit") ?? "20", 10) : undefined
        }
      : undefined;
  return { operation_id: operationId, method: "GET", path: url.pathname, project_id: projectId, body };
}

function isRelaySessionAuthorized(root: string, request: http.IncomingMessage): boolean {
  const pairing = readRelayPairingStatus(root);
  const header = request.headers["x-codexlink-relay-session"];
  return pairing.status === "paired" && typeof header === "string" && header === pairing.gpt_session_hint;
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  response.end(payload);
}

function readRequestBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        reject(new Error("Relay request body too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Relay request body must be JSON."));
      }
    });
    request.on("error", reject);
  });
}

function stringField(body: unknown, field: string): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function assertLoopbackHost(host: string): void {
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("Relay prototype only binds to loopback hosts. Use 127.0.0.1, localhost, or ::1.");
  }
}
