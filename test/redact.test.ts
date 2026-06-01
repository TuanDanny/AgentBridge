import { describe, expect, it } from "vitest";
import { detectRedaction, redactSecrets } from "../src/redact.js";

describe("redactSecrets", () => {
  it("redacts sensitive environment-style assignments", () => {
    const input = [
      "OPENAI_API_KEY=sk-123456789012345678901234",
      "client_secret: super-secret-value",
      "normal_value=visible"
    ].join("\n");

    const output = redactSecrets(input);

    expect(output).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(output).toContain("client_secret: [REDACTED]");
    expect(output).toContain("normal_value=visible");
    expect(output).not.toContain("super-secret-value");
    expect(output).not.toContain("sk-123456789012345678901234");
  });

  it("redacts private key blocks and bearer tokens", () => {
    const input = `-----BEGIN PRIVATE KEY-----
abc123
-----END PRIVATE KEY-----
Authorization: Bearer abcdefghijklmnopqrstuvwxyz`;

    const output = redactSecrets(input);

    expect(output).toContain("[REDACTED]");
    expect(output).toContain("Bearer [REDACTED]");
    expect(output).not.toContain("abc123");
    expect(detectRedaction(input)).toBe(true);
  });
});
