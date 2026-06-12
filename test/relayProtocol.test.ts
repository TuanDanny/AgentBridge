import { describe, expect, it } from "vitest";
import { getRelayProtocolSpec, validateRelayProtocolSpec, validateRelayRequestEnvelope } from "../src/relayProtocol.js";

describe("relay protocol spec", () => {
  it("is spec-only and validates security guardrails", () => {
    const spec = getRelayProtocolSpec();
    const validation = validateRelayProtocolSpec(spec);
    expect(spec.status).toBe("spec_only");
    expect(validation).toEqual({ ok: true, errors: [] });
    expect(spec.pairing).toMatchObject({
      required: true,
      single_use_code: true,
      session_bound: true,
      revocation_required: true
    });
  });

  it("does not expose mcp, command, write, token, or raw content routes", () => {
    const serialized = JSON.stringify(getRelayProtocolSpec()).toLowerCase();
    expect(serialized).not.toContain("/mcp");
    expect(serialized).not.toContain("command_runner");
    expect(serialized).not.toContain("write_file");
    expect(serialized).not.toContain("local_token");
    expect(serialized).not.toContain("openai_api_key");
    expect(serialized).toContain("no raw file content");
  });

  it("keeps all allowed routes scoped to relay or chatgpt metadata paths", () => {
    const spec = getRelayProtocolSpec();
    expect(spec.allowed_routes.length).toBeGreaterThan(0);
    for (const route of spec.allowed_routes) {
      expect(["GET", "POST"]).toContain(route.method);
      expect(route.path.startsWith("/chatgpt/") || route.path.startsWith("/relay/")).toBe(true);
      expect(route.response_content_policy === "metadata_only" || route.response_content_policy === "bounded_redacted_json").toBe(true);
    }
  });

  it("validates allowlisted relay request envelopes", () => {
    const valid = validateRelayRequestEnvelope({
      operation_id: "getSessionSummary",
      method: "GET",
      path: "/chatgpt/projects/AgentBridge/session/summary",
      project_id: "AgentBridge"
    });

    expect(valid.ok).toBe(true);
    expect(valid.errors).toEqual([]);
    expect(valid.route?.operation_id).toBe("getSessionSummary");
  });

  it("rejects relay request envelopes for unsafe routes and project ids", () => {
    const cases = [
      validateRelayRequestEnvelope({ operation_id: "unknown", method: "GET", path: "/chatgpt/projects" }),
      validateRelayRequestEnvelope({ operation_id: "getSessionSummary", method: "POST", path: "/chatgpt/projects/AgentBridge/session/summary", project_id: "AgentBridge" }),
      validateRelayRequestEnvelope({ operation_id: "getSessionSummary", method: "GET", path: "/mcp", project_id: "AgentBridge" }),
      validateRelayRequestEnvelope({ operation_id: "getSessionSummary", method: "GET", path: "/chatgpt/projects/D:/AgentBridge/session/summary", project_id: "D:/AgentBridge" }),
      validateRelayRequestEnvelope({ operation_id: "getSessionSummary", method: "GET", path: "/chatgpt/projects/../secret/session/summary", project_id: "../secret" }),
      validateRelayRequestEnvelope({ operation_id: "getSessionSummary", method: "GET", path: "/chatgpt/projects/AgentBridge/session/summary", project_id: "AgentBridge", body: { action: "write_file" } })
    ];

    for (const result of cases) {
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("caps relay request envelope size", () => {
    const result = validateRelayRequestEnvelope({
      operation_id: "getSessionSummary",
      method: "GET",
      path: "/chatgpt/projects/AgentBridge/session/summary",
      project_id: "AgentBridge",
      body: { padding: "x".repeat(70 * 1024) }
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("exceeds"))).toBe(true);
  });
});
