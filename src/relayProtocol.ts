export interface RelayAllowedRoute {
  operation_id: string;
  method: "GET" | "POST";
  path: string;
  purpose: string;
  response_content_policy: "metadata_only" | "bounded_redacted_json";
}

export interface RelayProtocolSpec {
  version: 1;
  status: "spec_only";
  transport: {
    gpt_to_relay: "HTTPS";
    launcher_to_relay: "WSS";
    relay_to_local_agent: "local_http_via_launcher";
  };
  pairing: {
    required: true;
    code_ttl_seconds: number;
    single_use_code: true;
    session_bound: true;
    revocation_required: true;
  };
  limits: {
    max_request_bytes: number;
    max_response_bytes: number;
    max_requests_per_minute_per_device: number;
    max_requests_per_minute_per_session: number;
  };
  allowed_routes: RelayAllowedRoute[];
  forbidden_capabilities: string[];
  audit_policy: {
    metadata_only: true;
    redact_logs: true;
    no_raw_file_content: true;
    no_raw_diff: true;
    no_long_terminal_output: true;
  };
}

export interface RelayProtocolValidation {
  ok: boolean;
  errors: string[];
}

const FORBIDDEN_TERMS = [
  "shell",
  "command_runner",
  "write_file",
  "file_write",
  "file_edit",
  "local_token",
  "openai_api_key",
  "/mcp"
];

export function getRelayProtocolSpec(): RelayProtocolSpec {
  return {
    version: 1,
    status: "spec_only",
    transport: {
      gpt_to_relay: "HTTPS",
      launcher_to_relay: "WSS",
      relay_to_local_agent: "local_http_via_launcher"
    },
    pairing: {
      required: true,
      code_ttl_seconds: 300,
      single_use_code: true,
      session_bound: true,
      revocation_required: true
    },
    limits: {
      max_request_bytes: 64 * 1024,
      max_response_bytes: 512 * 1024,
      max_requests_per_minute_per_device: 60,
      max_requests_per_minute_per_session: 30
    },
    allowed_routes: [
      {
        operation_id: "listProjects",
        method: "GET",
        path: "/chatgpt/projects",
        purpose: "Project picker metadata for explicitly registered projects.",
        response_content_policy: "metadata_only"
      },
      {
        operation_id: "getSessionSummary",
        method: "GET",
        path: "/chatgpt/projects/{projectId}/session/summary",
        purpose: "Shared session summary, recent activity, checks, evidence, and workspace warnings.",
        response_content_policy: "bounded_redacted_json"
      },
      {
        operation_id: "getSessionContext",
        method: "GET",
        path: "/chatgpt/projects/{projectId}/session/context",
        purpose: "Compact resume context for an already selected project.",
        response_content_policy: "bounded_redacted_json"
      },
      {
        operation_id: "getSessionTimeline",
        method: "GET",
        path: "/chatgpt/projects/{projectId}/session/timeline",
        purpose: "Bounded task, handoff, or file activity timeline metadata.",
        response_content_policy: "bounded_redacted_json"
      },
      {
        operation_id: "pairDevice",
        method: "POST",
        path: "/relay/pair",
        purpose: "Bind a short-lived pairing code to a GPT session and connected device.",
        response_content_policy: "metadata_only"
      },
      {
        operation_id: "relayHealth",
        method: "GET",
        path: "/relay/health",
        purpose: "Relay health and protocol version metadata.",
        response_content_policy: "metadata_only"
      }
    ],
    forbidden_capabilities: [
      "No arbitrary shell or command runner.",
      "No file write or edit route.",
      "No local auth token exposure to GPTs.",
      "No OpenAI API key requirement.",
      "No HTTP MCP endpoint.",
      "No raw file content relay storage.",
      "No raw diff relay storage.",
      "No long terminal output relay storage."
    ],
    audit_policy: {
      metadata_only: true,
      redact_logs: true,
      no_raw_file_content: true,
      no_raw_diff: true,
      no_long_terminal_output: true
    }
  };
}

export function validateRelayProtocolSpec(spec: RelayProtocolSpec = getRelayProtocolSpec()): RelayProtocolValidation {
  const errors: string[] = [];
  if (spec.status !== "spec_only") {
    errors.push("Relay protocol must remain spec_only until implementation is explicitly approved.");
  }
  if (!spec.pairing.required || !spec.pairing.single_use_code || !spec.pairing.session_bound || !spec.pairing.revocation_required) {
    errors.push("Relay protocol must require pairing, single-use code, session binding, and revocation.");
  }
  if (spec.limits.max_request_bytes > 64 * 1024) {
    errors.push("Relay max_request_bytes is too large for MVP.");
  }
  if (spec.limits.max_response_bytes > 512 * 1024) {
    errors.push("Relay max_response_bytes is too large for MVP.");
  }
  for (const route of spec.allowed_routes) {
    const normalized = `${route.method} ${route.path} ${route.operation_id}`.toLowerCase();
    for (const forbidden of FORBIDDEN_TERMS) {
      if (normalized.includes(forbidden)) {
        errors.push(`Relay route ${route.operation_id} contains forbidden term ${forbidden}.`);
      }
    }
    if (!route.path.startsWith("/chatgpt/") && !route.path.startsWith("/relay/")) {
      errors.push(`Relay route ${route.operation_id} must stay within /chatgpt/* or /relay/*.`);
    }
  }
  if (!spec.audit_policy.metadata_only || !spec.audit_policy.redact_logs) {
    errors.push("Relay audit policy must be metadata-only and redacted.");
  }
  if (!spec.audit_policy.no_raw_file_content || !spec.audit_policy.no_raw_diff || !spec.audit_policy.no_long_terminal_output) {
    errors.push("Relay audit policy must prohibit raw content, raw diffs, and long terminal output.");
  }
  return { ok: errors.length === 0, errors };
}

export function formatRelayProtocolSummary(spec: RelayProtocolSpec = getRelayProtocolSpec()): string {
  const validation = validateRelayProtocolSpec(spec);
  return [
    "CodexLink Relay Protocol",
    `Status: ${spec.status}`,
    `Transport: GPTs HTTPS -> relay -> launcher WSS -> local AgentBridge`,
    `Pairing: required, ttl=${spec.pairing.code_ttl_seconds}s, single_use=${spec.pairing.single_use_code}`,
    `Allowed routes: ${spec.allowed_routes.map((route) => route.operation_id).join(", ")}`,
    `Validation: ${validation.ok ? "PASS" : "FAIL"}`,
    ...(validation.errors.length ? validation.errors.map((error) => `- ${error}`) : []),
    "",
    "This is a protocol spec only. It does not start a relay server or expose local tools."
  ].join("\n");
}
