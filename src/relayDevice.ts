import { randomBytes, randomUUID, createHash } from "node:crypto";
import { bridgePath, getBridgeDir, resolveProjectRoot } from "./paths.js";
import { ensureDir, readJsonIfExists, writeJson } from "./fsx.js";

export interface RelayDeviceFile {
  version: 1;
  device_id: string;
  device_secret: string;
  created_at: string;
  updated_at: string;
}

export interface RelayDevicePublic {
  device_id: string;
  created_at: string;
  updated_at: string;
  secret_stored_locally: true;
  secret_printed: false;
}

export function relayDevicePath(rootInput = process.cwd()): string {
  return bridgePath(resolveProjectRoot(rootInput), "relay-device.json");
}

export function getOrCreateRelayDevice(rootInput = process.cwd()): RelayDeviceFile {
  const root = resolveProjectRoot(rootInput);
  const existing = readJsonIfExists<RelayDeviceFile>(relayDevicePath(root));
  if (existing?.version === 1 && existing.device_id && existing.device_secret) {
    return existing;
  }
  const now = new Date().toISOString();
  const device: RelayDeviceFile = {
    version: 1,
    device_id: `device_${randomUUID()}`,
    device_secret: randomBytes(32).toString("base64url"),
    created_at: now,
    updated_at: now
  };
  ensureDir(getBridgeDir(root));
  writeJson(relayDevicePath(root), device);
  return device;
}

export function relayDevicePublic(device: RelayDeviceFile): RelayDevicePublic {
  return {
    device_id: device.device_id,
    created_at: device.created_at,
    updated_at: device.updated_at,
    secret_stored_locally: true,
    secret_printed: false
  };
}

export function relayDeviceSecretDigest(device: RelayDeviceFile): string {
  return createHash("sha256").update(device.device_secret).digest("hex");
}
