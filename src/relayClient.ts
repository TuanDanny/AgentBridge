import { URL } from "node:url";
import { WebSocket } from "ws";
import { dispatchRelayRequestLocally } from "./relayLocalDispatch.js";
import { getOrCreateRelayDevice, relayDevicePublic, relayDeviceSecretDigest } from "./relayDevice.js";
import { createRelayPairingCode, hashRelayPairingCode } from "./relaySecurity.js";
import { getRelayProtocolSpec, type RelayRequestEnvelope } from "./relayProtocol.js";
import { resolveProjectRoot } from "./paths.js";
import { validateProjectId } from "./registry.js";
import { readRelayPairingRegistration } from "./relayPairing.js";

export interface RelayClientConnectOptions {
  relayUrl: string;
  projectId: string;
  root?: string;
  ttlSeconds?: number;
  useLocalPairing?: boolean;
}

export interface RunningRelayClient {
  pairing_code: string;
  pairing_expires_at: string;
  device: ReturnType<typeof relayDevicePublic>;
  relay_url: string;
  websocket_url: string;
  close: () => Promise<void>;
}

const DEFAULT_PAIRING_TTL_SECONDS = 300;

export async function startRelayClient(options: RelayClientConnectOptions): Promise<RunningRelayClient> {
  const root = resolveProjectRoot(options.root ?? process.cwd());
  const projectId = validateProjectId(options.projectId);
  const allowedProjectIds = [projectId];
  const relayUrl = normalizeRelayUrl(options.relayUrl);
  const websocketUrl = relayDeviceWebSocketUrl(relayUrl);
  const ttlSeconds = normalizeTtl(options.ttlSeconds);
  const generatedCode = options.useLocalPairing ? undefined : createRelayPairingCode();
  const localPairing = options.useLocalPairing ? readRelayPairingRegistration(root) : undefined;
  if (options.useLocalPairing && (!localPairing?.ok || !localPairing.code_hash || !localPairing.expires_at)) {
    throw new Error("No pending local relay pairing is available. Run relay pairing create first.");
  }
  const pairingCode = generatedCode ?? "";
  const pairingHash = localPairing?.code_hash ?? hashRelayPairingCode(pairingCode);
  const expiresAt = localPairing?.expires_at ?? new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const device = getOrCreateRelayDevice(root);
  const ws = new WebSocket(websocketUrl);
  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "heartbeat", device_id: device.device_id }));
    }
  }, 30000);

  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => {
      clearInterval(heartbeat);
      reject(error);
    };
    ws.once("error", fail);
    ws.once("open", () => {
      ws.off("error", fail);
      ws.send(
        JSON.stringify({
          type: "device_register",
          device_id: device.device_id,
          device_secret_digest: relayDeviceSecretDigest(device),
          pairing_code_hash: pairingHash,
          pairing_expires_at: expiresAt,
      allowed_projects: allowedProjectIds,
          content_stored: false
        })
      );
    });
    const onMessage = (message: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.toString("utf8"));
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }
      const record = parsed as Record<string, unknown>;
      if (record.type === "device_registered") {
        ws.off("message", onMessage);
        resolve();
      }
    };
    ws.on("message", onMessage);
  });

  ws.on("message", (message) => {
    void handleRelayMessage(root, allowedProjectIds, ws, message.toString("utf8"));
  });

  return {
    pairing_code: pairingCode,
    pairing_expires_at: expiresAt,
    device: relayDevicePublic(device),
    relay_url: relayUrl,
    websocket_url: websocketUrl,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        if (ws.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        ws.once("close", () => resolve());
        ws.close();
      })
  };
}

async function handleRelayMessage(root: string, allowedProjectIds: string[], ws: WebSocket, raw: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return;
  }
  const record = parsed as Record<string, unknown>;
  if (record.type !== "relay_request") {
    return;
  }
  const requestId = typeof record.request_id === "string" ? record.request_id : "";
  const envelope = record.envelope as RelayRequestEnvelope;
  if (!requestId || !envelope || typeof envelope !== "object") {
    return;
  }
  const result = capRelayResult(dispatchRelayRequestLocally(root, envelope, { allowedProjectIds }));
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "relay_response", request_id: requestId, result }));
  }
}

function capRelayResult(result: unknown): unknown {
  const maxBytes = getRelayProtocolSpec().limits.max_response_bytes;
  const payload = JSON.stringify(result);
  if (Buffer.byteLength(payload, "utf8") <= maxBytes) {
    return result;
  }
  return {
    ok: false,
    operation_id: typeof result === "object" && result ? (result as { operation_id?: string }).operation_id ?? "" : "",
    status: 502,
    error: {
      code: "relay_response_too_large",
      message: "Local response exceeded relay response cap."
    },
    metadata: {
      validated: true,
      request_bytes: 0,
      local_only: true,
      content_stored: false,
      truncated: true
    }
  };
}

function relayDeviceWebSocketUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/relay/device";
  url.search = "";
  return url.toString();
}

function normalizeRelayUrl(input: string): string {
  const url = new URL(input.trim());
  const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "https:" && url.protocol !== "wss:" && !(isLoopback && (url.protocol === "http:" || url.protocol === "ws:"))) {
    throw new Error("Relay URL must use https:// or wss://, except loopback test URLs may use http:// or ws://.");
  }
  url.protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
  return url.toString().replace(/\/$/, "");
}

function normalizeTtl(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_PAIRING_TTL_SECONDS;
  }
  if (!Number.isInteger(value) || value < 30 || value > 900) {
    throw new Error("Relay client pairing TTL must be an integer from 30 to 900 seconds.");
  }
  return value;
}
