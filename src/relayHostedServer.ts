import { randomUUID } from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { hashRelayPairingCode } from "./relaySecurity.js";
import { type RelayRequestEnvelope, getRelayProtocolSpec, validateRelayRequestEnvelope } from "./relayProtocol.js";

export interface RelayHostedServeOptions {
  host?: string;
  port?: number;
  publicUrl?: string;
  requestTimeoutMs?: number;
}

export interface RunningHostedRelayServer {
  server: http.Server;
  info: {
    host: string;
    port: number;
    public_url: string;
    started_at: string;
  };
  close: () => Promise<void>;
}

interface ConnectedDevice {
  device_id: string;
  ws: WebSocket;
  allowed_projects: string[];
  connected_at: string;
  last_seen_at: string;
}

interface PendingPairing {
  pairing_code_hash: string;
  device_id: string;
  expires_at: string;
  created_at: string;
}

interface RelaySession {
  relay_session: string;
  device_id: string;
  gpt_session: string;
  paired_at: string;
  expires_at: string;
}

interface PendingRelayRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;

export async function startHostedRelayServer(options: RelayHostedServeOptions = {}): Promise<RunningHostedRelayServer> {
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 8788;
  const publicUrl = normalizePublicUrl(options.publicUrl ?? `http://${host}:${port}`);
  const startedAt = new Date().toISOString();
  const protocol = getRelayProtocolSpec();
  const devices = new Map<string, ConnectedDevice>();
  const pairings = new Map<string, PendingPairing>();
  const sessions = new Map<string, RelaySession>();
  const pendingRequests = new Map<string, PendingRelayRequest>();
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    try {
      if (request.method === "GET" && url.pathname === "/relay/health") {
        cleanupExpired();
        sendJson(response, 200, {
          ok: true,
          name: "codexlink-hosted-relay",
          status: protocol.status,
          public_url: publicUrl,
          started_at: startedAt,
          connected_devices: devices.size,
          pending_pairings: pairings.size,
          active_sessions: sessions.size,
          content_stored: false
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/relay/pair") {
        const body = await readRequestBody(request, protocol.limits.max_request_bytes);
        const code = stringField(body, "code");
        const gptSession = stringField(body, "gpt_session") ?? `gpt_${randomUUID()}`;
        if (!code || !safeSessionHint(gptSession)) {
          sendJson(response, 400, { ok: false, error: { code: "invalid_pairing_request", message: "code and safe gpt_session are required." } });
          return;
        }
        cleanupExpired();
        const codeHash = hashRelayPairingCode(code);
        const pairing = pairings.get(codeHash);
        if (!pairing) {
          sendJson(response, 401, { ok: false, error: { code: "pairing_not_found", message: "Pairing code is invalid or expired." } });
          return;
        }
        const device = devices.get(pairing.device_id);
        if (!device || device.ws.readyState !== WebSocket.OPEN) {
          pairings.delete(codeHash);
          sendJson(response, 503, { ok: false, error: { code: "device_disconnected", message: "Local CodexLink device is not connected." } });
          return;
        }
        const now = Date.now();
        const relaySession = `relay_sess_${randomUUID()}`;
        const session: RelaySession = {
          relay_session: relaySession,
          device_id: pairing.device_id,
          gpt_session: gptSession,
          paired_at: new Date(now).toISOString(),
          expires_at: new Date(now + DEFAULT_SESSION_TTL_MS).toISOString()
        };
        pairings.delete(codeHash);
        sessions.set(relaySession, session);
        sendJson(response, 200, {
          ok: true,
          relay_session: relaySession,
          expires_at: session.expires_at,
          device_id_hint: device.device_id,
          code_value_stored: false,
          content_stored: false
        });
        return;
      }

      if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
        sendJson(response, 404, { ok: false, error: { code: "not_found", message: "CodexLink relay does not expose MCP." } });
        return;
      }

      const relaySession = relaySessionHeader(request);
      const session = relaySession ? sessions.get(relaySession) : undefined;
      if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
        if (relaySession) {
          sessions.delete(relaySession);
        }
        sendJson(response, 401, { ok: false, error: { code: "relay_session_required", message: "Pair the device and send X-CodexLink-Relay-Session." } });
        return;
      }
      const device = devices.get(session.device_id);
      if (!device || device.ws.readyState !== WebSocket.OPEN) {
        sendJson(response, 503, { ok: false, error: { code: "relay_device_unavailable", message: "Local CodexLink device is not connected to relay." } });
        return;
      }

      const envelope = relayEnvelopeFromHttpRequest(request.method ?? "GET", url);
      if (!envelope) {
        sendJson(response, 404, { ok: false, error: { code: "not_found", message: "Relay route is not allowlisted." } });
        return;
      }
      const validation = validateRelayRequestEnvelope(envelope, protocol);
      if (!validation.ok) {
        sendJson(response, 400, { ok: false, error: { code: "relay_request_rejected", message: validation.errors.join(" ") } });
        return;
      }
      const requestProjectId = envelope.project_id;
      if (requestProjectId && !device.allowed_projects.some((projectId) => projectId.toLowerCase() === requestProjectId.toLowerCase())) {
        sendJson(response, 404, { ok: false, error: { code: "project_not_allowed", message: "Project is not paired with this relay device." } });
        return;
      }
      const result = await forwardRequest(device, envelope, pendingRequests, requestTimeoutMs);
      sendBoundedJson(response, result, protocol.limits.max_response_bytes);
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: {
          code: "relay_hosted_error",
          message: error instanceof Error ? error.message : "Hosted relay error."
        }
      });
    }
  });

  const wss = new WebSocketServer({ server, path: "/relay/device" });
  wss.on("connection", (ws) => {
    ws.on("message", (message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.toString("utf8"));
      } catch {
        ws.close(1008, "Invalid JSON");
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        ws.close(1008, "Invalid message");
        return;
      }
      const record = parsed as Record<string, unknown>;
      if (record.type === "device_register") {
        const deviceId = stringField(record, "device_id");
        const codeHash = stringField(record, "pairing_code_hash");
        const expiresAt = stringField(record, "pairing_expires_at");
        if (!deviceId || !codeHash || !expiresAt || new Date(expiresAt).getTime() <= Date.now()) {
          ws.close(1008, "Invalid device registration");
          return;
        }
        const allowedProjects = Array.isArray(record.allowed_projects)
          ? record.allowed_projects.filter((value): value is string => typeof value === "string").slice(0, 50)
          : [];
        const now = new Date().toISOString();
        devices.set(deviceId, {
          device_id: deviceId,
          ws,
          allowed_projects: allowedProjects,
          connected_at: now,
          last_seen_at: now
        });
        pairings.set(codeHash, {
          pairing_code_hash: codeHash,
          device_id: deviceId,
          expires_at: expiresAt,
          created_at: now
        });
        ws.send(JSON.stringify({ type: "device_registered", ok: true, device_id: deviceId, expires_at: expiresAt, code_value_stored: false }));
        return;
      }
      if (record.type === "relay_response") {
        const requestId = stringField(record, "request_id");
        const pending = requestId ? pendingRequests.get(requestId) : undefined;
        if (!requestId || !pending) {
          return;
        }
        clearTimeout(pending.timeout);
        pendingRequests.delete(requestId);
        pending.resolve(record.result);
        return;
      }
      if (record.type === "heartbeat") {
        const deviceId = stringField(record, "device_id");
        const device = deviceId ? devices.get(deviceId) : undefined;
        if (device && device.ws === ws) {
          device.last_seen_at = new Date().toISOString();
        }
      }
    });
    ws.on("close", () => {
      for (const [deviceId, device] of devices.entries()) {
        if (device.ws === ws) {
          devices.delete(deviceId);
        }
      }
    });
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
      public_url: publicUrl,
      started_at: startedAt
    },
    close: async () => {
      for (const pending of pendingRequests.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Relay server closed."));
      }
      pendingRequests.clear();
      for (const device of devices.values()) {
        device.ws.close();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };

  function cleanupExpired(): void {
    const now = Date.now();
    for (const [hash, pairing] of pairings.entries()) {
      if (new Date(pairing.expires_at).getTime() <= now) {
        pairings.delete(hash);
      }
    }
    for (const [sessionId, session] of sessions.entries()) {
      if (new Date(session.expires_at).getTime() <= now) {
        sessions.delete(sessionId);
      }
    }
  }
}

export function relayEnvelopeFromHttpRequest(method: string, url: URL): RelayRequestEnvelope | undefined {
  if (method !== "GET") {
    return undefined;
  }
  if (url.pathname === "/chatgpt/projects") {
    return { operation_id: "listProjects", method: "GET", path: url.pathname };
  }
  const sessionMatch = /^\/chatgpt\/projects\/([^/]+)\/session\/(summary|context|timeline)$/.exec(url.pathname);
  if (sessionMatch) {
    const [, projectId, kind] = sessionMatch;
    const operationId = kind === "summary" ? "getSessionSummary" : kind === "context" ? "getSessionContext" : "getSessionTimeline";
    return { operation_id: operationId, method: "GET", path: url.pathname, project_id: projectId, body: queryBody(url) };
  }
  const projectMatch = /^\/chatgpt\/projects\/([^/]+)\/(inspect|codex-changes|review-packet|tree|files\/search|file|grep)$/.exec(url.pathname);
  if (!projectMatch) {
    return undefined;
  }
  const [, projectId, kind] = projectMatch;
  const operationId = operationIdForRelayKind(kind);
  if (!operationId) {
    return undefined;
  }
  const body = queryBody(url);
  if (operationId === "readProjectFile" && body.max_chars === undefined) {
    body.max_chars = 128 * 1024;
  }
  return { operation_id: operationId, method: "GET", path: url.pathname, project_id: projectId, body };
}

function operationIdForRelayKind(kind: string): string | undefined {
  return {
    inspect: "inspectProject",
    "codex-changes": "getCodexChanges",
    "review-packet": "getReviewPacket",
    tree: "getProjectTree",
    "files/search": "searchProjectFiles",
    file: "readProjectFile",
    grep: "searchProjectText"
  }[kind];
}

function queryBody(url: URL): Record<string, string | number | boolean> {
  const body: Record<string, string | number | boolean> = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (/^-?\d+$/.test(value)) {
      body[key] = Number.parseInt(value, 10);
    } else if (value.toLowerCase() === "true" || value.toLowerCase() === "false") {
      body[key] = value.toLowerCase() === "true";
    } else {
      body[key] = value;
    }
  }
  return body;
}

function forwardRequest(
  device: ConnectedDevice,
  envelope: RelayRequestEnvelope,
  pendingRequests: Map<string, PendingRelayRequest>,
  timeoutMs: number
): Promise<unknown> {
  const requestId = `relay_req_${randomUUID()}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("Local relay client did not respond before timeout."));
    }, timeoutMs);
    pendingRequests.set(requestId, { resolve, reject, timeout });
    device.ws.send(JSON.stringify({ type: "relay_request", request_id: requestId, envelope }));
  });
}

function sendBoundedJson(response: http.ServerResponse, body: unknown, maxBytes: number): void {
  const payload = JSON.stringify(body, null, 2);
  if (Buffer.byteLength(payload, "utf8") > maxBytes) {
    sendJson(response, 502, {
      ok: false,
      error: {
        code: "relay_response_too_large",
        message: "Local response exceeded relay response cap."
      },
      metadata: {
        content_stored: false,
        truncated: true
      }
    });
    return;
  }
  sendJson(response, typeof (body as { status?: unknown })?.status === "number" ? ((body as { status: number }).status) : 200, body);
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  response.end(payload);
}

function readRequestBody(request: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw, "utf8") > maxBytes) {
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

function relaySessionHeader(request: http.IncomingMessage): string | undefined {
  const value = request.headers["x-codexlink-relay-session"];
  return typeof value === "string" ? value : undefined;
}

function stringField(body: unknown, field: string): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function safeSessionHint(input: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(input);
}

function normalizePublicUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "https:") {
    throw new Error("Relay public URL must use https://. The relay app serves HTTP internally behind external HTTPS/WSS termination.");
  }
  return url.toString().replace(/\/$/, "");
}
