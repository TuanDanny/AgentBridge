import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function createRelayPairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  const chars = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

export function hashRelayPairingCode(code: string): string {
  return createHash("sha256").update(normalizeRelayPairingCode(code)).digest("hex");
}

export function safeEqualRelayHash(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeRelayPairingCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]+/g, "");
}
