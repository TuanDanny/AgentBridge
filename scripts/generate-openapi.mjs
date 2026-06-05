import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const openApiFiles = [
  path.join(root, "openapi.agentbridge.json"),
  path.join(root, "openapi.agentbridge.gpt-actions.json")
];

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
