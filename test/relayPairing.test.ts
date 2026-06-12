import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindRelayPairingCode,
  createRelayPairing,
  readRelayPairingStatus,
  relayPairingPath,
  revokeRelayPairing
} from "../src/relayPairing.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-relay-pairing-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("relay pairing core", () => {
  it("creates a short-lived pairing code without storing the raw code", () => {
    const root = makeTempRoot();
    const created = createRelayPairing(root, { ttlSeconds: 60, now: new Date("2026-06-12T00:00:00.000Z") });
    const stored = fs.readFileSync(relayPairingPath(root), "utf8");

    expect(created.status).toBe("pending");
    expect(created.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(created.ttl_seconds).toBe(60);
    expect(created.code_value_stored).toBe(false);
    expect(stored).toContain("code_hash");
    expect(stored).not.toContain(created.code);
    expect(stored).not.toContain("local_token");
    expect(stored).not.toContain("Bearer ");
    expect(stored).not.toContain("OPENAI_API_KEY");
    expect(stored).not.toContain("sk-");
  });

  it("binds exactly once and never returns the stored code hash as a token", () => {
    const root = makeTempRoot();
    const created = createRelayPairing(root, { ttlSeconds: 300 });

    const bound = bindRelayPairingCode(root, created.code.replace("-", "").toLowerCase(), "gpt-session-1");
    expect(bound.ok).toBe(true);
    expect(bound.status).toBe("paired");
    expect(bound.matched).toBe(true);
    expect(bound.gpt_session_hint).toBe("gpt-session-1");
    expect(JSON.stringify(bound)).not.toContain(created.code);

    const rebound = bindRelayPairingCode(root, created.code, "gpt-session-1");
    expect(rebound.ok).toBe(false);
    expect(rebound.matched).toBe(false);
    expect(rebound.status).toBe("paired");
  });

  it("expires pending codes and supports revocation", () => {
    const root = makeTempRoot();
    const created = createRelayPairing(root, { ttlSeconds: 30, now: new Date("2026-06-12T00:00:00.000Z") });
    const expired = readRelayPairingStatus(root, new Date("2026-06-12T00:00:31.000Z"));
    expect(expired.status).toBe("expired");

    const bindExpired = bindRelayPairingCode(root, created.code, "gpt-session-2", new Date("2026-06-12T00:00:31.000Z"));
    expect(bindExpired.ok).toBe(false);
    expect(bindExpired.status).toBe("expired");

    const revoked = revokeRelayPairing(root, new Date("2026-06-12T00:00:32.000Z"));
    expect(revoked.status).toBe("revoked");
    expect(readRelayPairingStatus(root).status).toBe("revoked");
  });

  it("rejects unsafe session hints and TTL values", () => {
    const root = makeTempRoot();
    const created = createRelayPairing(root, { ttlSeconds: 30 });

    expect(() => createRelayPairing(root, { ttlSeconds: 1 })).toThrow(/TTL/);
    expect(() => bindRelayPairingCode(root, created.code, "../bad")).toThrow(/safe short identifier/);
  });
});
