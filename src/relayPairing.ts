import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { bridgePath, resolveProjectRoot } from "./paths.js";
import { ensureDir, readJsonIfExists, writeJson } from "./fsx.js";

export type RelayPairingStatus = "pending" | "paired" | "revoked" | "expired" | "missing";

export interface RelayPairingFile {
  version: 1;
  pairing_id: string;
  device_id: string;
  code_hash: string;
  status: Exclude<RelayPairingStatus, "missing">;
  created_at: string;
  expires_at: string;
  paired_at?: string;
  revoked_at?: string;
  gpt_session_hint?: string;
}

export interface RelayPairingPublicStatus {
  ok: boolean;
  status: RelayPairingStatus;
  pairing_id?: string;
  device_id?: string;
  created_at?: string;
  expires_at?: string;
  paired_at?: string;
  revoked_at?: string;
  gpt_session_hint?: string;
  code_hash_stored?: boolean;
  code_value_stored: false;
}

export interface RelayPairingCreateResult extends RelayPairingPublicStatus {
  code: string;
  ttl_seconds: number;
  next_steps: string[];
}

export interface RelayPairingBindResult extends RelayPairingPublicStatus {
  matched: boolean;
}

export interface RelayPairingOptions {
  ttlSeconds?: number;
  now?: Date;
}

const DEFAULT_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 900;
const GPT_SESSION_HINT_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function relayPairingPath(rootInput = process.cwd()): string {
  return bridgePath(resolveProjectRoot(rootInput), "relay-pairing.json");
}

export function createRelayPairing(rootInput = process.cwd(), options: RelayPairingOptions = {}): RelayPairingCreateResult {
  const root = resolveProjectRoot(rootInput);
  const now = options.now ?? new Date();
  const ttlSeconds = normalizeTtl(options.ttlSeconds);
  const code = createPairingCode();
  const pairing: RelayPairingFile = {
    version: 1,
    pairing_id: `relay_pair_${randomUUID()}`,
    device_id: `device_${randomUUID()}`,
    code_hash: hashPairingCode(code),
    status: "pending",
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlSeconds * 1000).toISOString()
  };
  ensureDir(bridgePath(root, "."));
  writeJson(relayPairingPath(root), pairing);
  return {
    ...toPublicStatus(pairing, now),
    code,
    ttl_seconds: ttlSeconds,
    next_steps: [
      "Paste this short-lived pairing code into the trusted GPTs relay pairing flow.",
      "The raw pairing code is printed once and is not stored in .agentbridge.",
      "Relay forwarding remains disabled until a future relay server/client is implemented."
    ]
  };
}

export function readRelayPairingStatus(rootInput = process.cwd(), now = new Date()): RelayPairingPublicStatus {
  const pairing = readRelayPairingFile(rootInput);
  if (!pairing) {
    return { ok: true, status: "missing", code_value_stored: false };
  }
  return toPublicStatus(pairing, now);
}

export function bindRelayPairingCode(
  rootInput = process.cwd(),
  code: string,
  gptSessionHint: string,
  now = new Date()
): RelayPairingBindResult {
  const root = resolveProjectRoot(rootInput);
  const pairing = readRelayPairingFile(root);
  if (!pairing) {
    return { ok: false, status: "missing", matched: false, code_value_stored: false };
  }
  const publicStatus = toPublicStatus(pairing, now);
  if (publicStatus.status !== "pending") {
    return { ...publicStatus, ok: false, matched: false };
  }
  if (!GPT_SESSION_HINT_PATTERN.test(gptSessionHint)) {
    throw new Error("GPT session hint must be a safe short identifier.");
  }
  const matched = safeEqualHash(pairing.code_hash, hashPairingCode(code));
  if (!matched) {
    return { ...publicStatus, ok: false, matched: false };
  }
  const updated: RelayPairingFile = {
    ...pairing,
    status: "paired",
    paired_at: now.toISOString(),
    gpt_session_hint: gptSessionHint
  };
  writeJson(relayPairingPath(root), updated);
  return { ...toPublicStatus(updated, now), matched: true };
}

export function revokeRelayPairing(rootInput = process.cwd(), now = new Date()): RelayPairingPublicStatus {
  const root = resolveProjectRoot(rootInput);
  const pairing = readRelayPairingFile(root);
  if (!pairing) {
    return { ok: true, status: "missing", code_value_stored: false };
  }
  const updated: RelayPairingFile = {
    ...pairing,
    status: "revoked",
    revoked_at: now.toISOString()
  };
  writeJson(relayPairingPath(root), updated);
  return toPublicStatus(updated, now);
}

function readRelayPairingFile(rootInput: string): RelayPairingFile | undefined {
  return readJsonIfExists<RelayPairingFile>(relayPairingPath(rootInput));
}

function toPublicStatus(pairing: RelayPairingFile, now: Date): RelayPairingPublicStatus {
  const expired = pairing.status === "pending" && new Date(pairing.expires_at).getTime() <= now.getTime();
  return {
    ok: true,
    status: expired ? "expired" : pairing.status,
    pairing_id: pairing.pairing_id,
    device_id: pairing.device_id,
    created_at: pairing.created_at,
    expires_at: pairing.expires_at,
    paired_at: pairing.paired_at,
    revoked_at: pairing.revoked_at,
    gpt_session_hint: pairing.gpt_session_hint,
    code_hash_stored: Boolean(pairing.code_hash),
    code_value_stored: false
  };
}

function normalizeTtl(ttlSeconds: number | undefined): number {
  if (ttlSeconds === undefined) {
    return DEFAULT_TTL_SECONDS;
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(`Relay pairing TTL must be an integer from 30 to ${MAX_TTL_SECONDS} seconds.`);
  }
  return ttlSeconds;
}

function createPairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  const chars = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

function hashPairingCode(code: string): string {
  return createHash("sha256").update(normalizeCode(code)).digest("hex");
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]+/g, "");
}

function safeEqualHash(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
