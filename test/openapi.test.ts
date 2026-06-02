import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const specPath = path.resolve("openapi.agentbridge.json");
const gptActionsSpecPath = path.resolve("openapi.agentbridge.gpt-actions.json");

interface OperationSpec {
  operationId?: string;
  parameters?: Array<Record<string, unknown>>;
}

interface OpenApiSpec {
  openapi: string;
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, OperationSpec>>;
  components: {
    schemas?: Record<string, unknown>;
    securitySchemes: Record<string, { type: string; scheme: string }>;
  };
}

function operations(spec: OpenApiSpec): OperationSpec[] {
  return Object.values(spec.paths).flatMap((pathItem) => Object.values(pathItem));
}

describe("ChatGPT tool adapter OpenAPI spec", () => {
  it("parses as JSON and describes the project inspector endpoints", () => {
    const content = fs.readFileSync(specPath, "utf8");
    const spec = JSON.parse(content) as {
      openapi: string;
      servers: Array<{ url: string }>;
      paths: Record<string, Record<string, { operationId?: string; security?: unknown }>>;
      components: {
        securitySchemes: Record<string, { type: string; scheme: string }>;
      };
    };

    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers[0].url).toBe("https://YOUR-TUNNEL-URL.example");
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer"
    });

    expect(spec.paths["/chatgpt/projects"].get.operationId).toBe("listProjects");
    expect(spec.paths["/chatgpt/projects/{projectId}/inspect"].get.operationId).toBe("inspectProject");
    expect(spec.paths["/chatgpt/projects/{projectId}/codex-changes"].get.operationId).toBe("getCodexChanges");
    expect(spec.paths["/chatgpt/projects/{projectId}/review-packet"].get.operationId).toBe("getReviewPacket");
  });

  it("does not include secrets or claim HTTP MCP", () => {
    const content = fs.readFileSync(specPath, "utf8");
    const spec = JSON.parse(content) as { paths: Record<string, unknown> };

    expect(Object.keys(spec.paths)).not.toContain("/mcp");
    expect(content).not.toContain(".agentbridge/local_token");
    expect(content).not.toContain("local_token");
    expect(content).not.toContain("OPENAI_API_KEY=");
    expect(content).not.toContain("CODEX_API_KEY=");
    expect(content).not.toContain("sk-");
    expect(content).not.toContain("ghp_");
    expect(content).not.toContain("trycloudflare.com");
  });

  it("provides a GPT Actions compatible schema with inline operation parameters", () => {
    const content = fs.readFileSync(gptActionsSpecPath, "utf8");
    const spec = JSON.parse(content) as OpenApiSpec;

    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers[0].url).toBe("https://YOUR-TUNNEL-URL.example");
    expect(spec.components.schemas).toBeDefined();
    expect(typeof spec.components.schemas).toBe("object");
    expect(Array.isArray(spec.components.schemas)).toBe(false);
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer"
    });
    expect(Object.keys(spec.paths)).not.toContain("/mcp");
    expect(Object.keys(spec.paths)).toEqual([
      "/chatgpt/projects",
      "/chatgpt/projects/{projectId}/inspect",
      "/chatgpt/projects/{projectId}/codex-changes",
      "/chatgpt/projects/{projectId}/review-packet"
    ]);

    expect(spec.paths["/chatgpt/projects"].get.operationId).toBe("listProjects");
    expect(spec.paths["/chatgpt/projects/{projectId}/inspect"].get.operationId).toBe("inspectProject");
    expect(spec.paths["/chatgpt/projects/{projectId}/codex-changes"].get.operationId).toBe("getCodexChanges");
    expect(spec.paths["/chatgpt/projects/{projectId}/review-packet"].get.operationId).toBe("getReviewPacket");

    for (const operation of operations(spec)) {
      for (const parameter of operation.parameters ?? []) {
        expect(parameter).not.toHaveProperty("$ref");
        expect(typeof parameter.name).toBe("string");
        expect(typeof parameter.in).toBe("string");
        expect(typeof parameter.required).toBe("boolean");
        expect(typeof parameter.description).toBe("string");
        expect(parameter.schema).toBeDefined();
      }
    }

    for (const pathName of [
      "/chatgpt/projects/{projectId}/inspect",
      "/chatgpt/projects/{projectId}/codex-changes",
      "/chatgpt/projects/{projectId}/review-packet"
    ]) {
      const parameterNames = spec.paths[pathName].get.parameters?.map((parameter) => parameter.name);
      expect(parameterNames).toEqual(["projectId", "mode", "max_chars", "include_diff"]);
    }
  });

  it("keeps the GPT Actions schema free of secrets", () => {
    const content = fs.readFileSync(gptActionsSpecPath, "utf8");

    expect(content).not.toContain(".agentbridge/local_token");
    expect(content).not.toContain("local_token");
    expect(content).not.toContain("OPENAI_API_KEY=");
    expect(content).not.toContain("CODEX_API_KEY=");
    expect(content).not.toContain("sk-");
    expect(content).not.toContain("ghp_");
    expect(content).not.toContain("trycloudflare.com");
  });
});
