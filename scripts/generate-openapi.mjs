import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const openApiFiles = [
  path.join(root, "openapi.agentbridge.json"),
  path.join(root, "openapi.agentbridge.gpt-actions.json")
];
const relayGptActionsFile = path.join(root, "openapi.codexlink.relay.gpt-actions.json");

const actors = ["user", "chatgpt", "codex", "system"];
const eventTypes = [
  "note",
  "decision",
  "correction",
  "handoff",
  "implementation",
  "review",
  "test_result",
  "commit",
  "warning",
  "blocker"
];
const handoffStatuses = ["open", "acknowledged", "in_progress", "done", "blocked", "cancelled", "superseded"];
const sessionPhases = ["planning", "implementation", "review", "blocked", "done"];
const sessionStatuses = ["active", "in_progress", "blocked", "done"];

function stringSchema(extra = {}) {
  return { type: "string", ...extra };
}

function stringArraySchema() {
  return {
    type: "array",
    items: stringSchema()
  };
}

const sessionRequestBodySchemas = {
  "/chatgpt/projects/{projectId}/session/events": {
    type: "object",
    required: ["actor", "type", "summary"],
    properties: {
      actor: stringSchema({ enum: actors }),
      type: stringSchema({ enum: eventTypes }),
      summary: stringSchema(),
      details: stringSchema()
    },
    additionalProperties: false
  },
  "/chatgpt/projects/{projectId}/session/handoffs": {
    type: "object",
    required: ["from", "to", "title", "message"],
    properties: {
      from: stringSchema({ enum: actors }),
      to: stringSchema({ enum: actors }),
      title: stringSchema(),
      message: stringSchema(),
      constraints: stringArraySchema(),
      expected_output: stringArraySchema()
    },
    additionalProperties: false
  },
  "/chatgpt/projects/{projectId}/session/handoffs/{handoffId}": {
    type: "object",
    required: ["status"],
    properties: {
      status: stringSchema({ enum: handoffStatuses }),
      result_summary: stringSchema()
    },
    additionalProperties: false
  },
  "/chatgpt/projects/{projectId}/session/goal": {
    type: "object",
    required: ["goal"],
    properties: {
      goal: stringSchema(),
      phase: stringSchema({ enum: sessionPhases }),
      status: stringSchema({ enum: sessionStatuses })
    },
    additionalProperties: false
  }
};

function jsonRequestBody(schema) {
  return {
    required: true,
    content: {
      "application/json": {
        schema
      }
    }
  };
}

for (const file of openApiFiles) {
  const spec = JSON.parse(fs.readFileSync(file, "utf8"));

  for (const [pathName, schema] of Object.entries(sessionRequestBodySchemas)) {
    const operation = spec.paths?.[pathName]?.post;
    if (!operation) {
      throw new Error(`Missing POST operation for ${pathName} in ${path.basename(file)}`);
    }
    operation.requestBody = jsonRequestBody(schema);
  }

  fs.writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`);
  console.log(`generated ${path.relative(root, file)}`);
}

const relaySessionHeader = {
  name: "X-CodexLink-Relay-Session",
  in: "header",
  required: true,
  description: "Relay session binding from the CodexLink pairing flow. Do not use the local auth token here.",
  schema: stringSchema()
};

const relayProjectId = {
  name: "projectId",
  in: "path",
  required: true,
  description: "Safe project id from listProjects.",
  schema: stringSchema({ pattern: "^[A-Za-z0-9._-]{1,80}$" })
};

const relayTimelineParams = [
  {
    name: "mode",
    in: "query",
    required: false,
    description: "Timeline mode.",
    schema: stringSchema({ enum: ["recent", "handoff", "file", "task"] })
  },
  {
    name: "handoff_id",
    in: "query",
    required: false,
    description: "Optional handoff id filter.",
    schema: stringSchema()
  },
  {
    name: "file_path",
    in: "query",
    required: false,
    description: "Optional project-relative file path filter.",
    schema: stringSchema()
  },
  {
    name: "task_id",
    in: "query",
    required: false,
    description: "Optional task or correlation id filter.",
    schema: stringSchema()
  },
  {
    name: "limit",
    in: "query",
    required: false,
    description: "Maximum timeline items.",
    schema: { type: "integer", minimum: 1, maximum: 50 }
  }
];

function relayJsonResponse(description) {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          type: "object",
          additionalProperties: true
        }
      }
    }
  };
}

const relaySpec = {
  openapi: "3.1.0",
  info: {
    title: "CodexLink Relay GPT Actions",
    version: "1.2.0-prototype",
    description:
      "GPT Actions schema for the planned CodexLink stable relay. It exposes paired metadata routes only and is not a production hosted relay by itself."
  },
  servers: [
    {
      url: "https://relay.codexlink.example.com",
      description: "Replace with your trusted CodexLink relay HTTPS origin."
    }
  ],
  paths: {
    "/relay/health": {
      get: {
        operationId: "relayHealth",
        summary: "Check relay health",
        description: "Return relay protocol and health metadata.",
        responses: {
          "200": relayJsonResponse("Relay health metadata")
        }
      }
    },
    "/relay/pair": {
      post: {
        operationId: "pairDevice",
        summary: "Pair CodexLink device",
        description: "Bind a short-lived pairing code to this GPT relay session.",
        requestBody: jsonRequestBody({
          type: "object",
          required: ["code", "gpt_session"],
          properties: {
            code: stringSchema({ description: "Short-lived pairing code shown by CodexLink launcher." }),
            gpt_session: stringSchema({ description: "Safe GPT relay session hint." })
          },
          additionalProperties: false
        }),
        responses: {
          "200": relayJsonResponse("Pairing accepted"),
          "401": relayJsonResponse("Pairing rejected")
        }
      }
    },
    "/chatgpt/projects": {
      get: {
        operationId: "listProjects",
        summary: "List CodexLink projects",
        description: "List registered CodexLink projects through a paired relay session.",
        parameters: [relaySessionHeader],
        responses: {
          "200": relayJsonResponse("Project picker metadata"),
          "401": relayJsonResponse("Relay session required")
        }
      }
    },
    "/chatgpt/projects/{projectId}/session/summary": {
      get: {
        operationId: "getSessionSummary",
        summary: "Get session summary",
        description: "Get compact shared session memory for one safe project id.",
        parameters: [relaySessionHeader, relayProjectId],
        responses: {
          "200": relayJsonResponse("Session summary metadata"),
          "401": relayJsonResponse("Relay session required"),
          "404": relayJsonResponse("Project not found")
        }
      }
    },
    "/chatgpt/projects/{projectId}/session/context": {
      get: {
        operationId: "getSessionContext",
        summary: "Get compact session context",
        description: "Get resume context, activity, checks, evidence, and workspace warnings.",
        parameters: [relaySessionHeader, relayProjectId],
        responses: {
          "200": relayJsonResponse("Compact context metadata"),
          "401": relayJsonResponse("Relay session required"),
          "404": relayJsonResponse("Project not found")
        }
      }
    },
    "/chatgpt/projects/{projectId}/session/timeline": {
      get: {
        operationId: "getSessionTimeline",
        summary: "Get session timeline",
        description: "Get recent, handoff, file, or task activity timeline metadata.",
        parameters: [relaySessionHeader, relayProjectId, ...relayTimelineParams],
        responses: {
          "200": relayJsonResponse("Timeline metadata"),
          "401": relayJsonResponse("Relay session required"),
          "404": relayJsonResponse("Project not found")
        }
      }
    }
  },
  components: {
    schemas: {},
    securitySchemes: {
      relaySession: {
        type: "apiKey",
        in: "header",
        name: "X-CodexLink-Relay-Session"
      }
    }
  }
};

fs.writeFileSync(relayGptActionsFile, `${JSON.stringify(relaySpec, null, 2)}\n`);
console.log(`generated ${path.relative(root, relayGptActionsFile)}`);
