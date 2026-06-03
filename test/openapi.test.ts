import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const specPath = path.resolve("openapi.agentbridge.json");
const gptActionsSpecPath = path.resolve("openapi.agentbridge.gpt-actions.json");

interface OperationSpec {
  operationId?: string;
  description?: string;
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

function parameterByName(operation: OperationSpec, name: string): Record<string, unknown> | undefined {
  return operation.parameters?.find((parameter) => parameter.name === name);
}

describe("ChatGPT tool adapter OpenAPI spec", () => {
  it("parses as JSON and describes the project inspector endpoints", () => {
    const content = fs.readFileSync(specPath, "utf8");
    const spec = JSON.parse(content) as {
      openapi: string;
      servers: Array<{ url: string }>;
      paths: Record<string, Record<string, { operationId?: string; description?: string; security?: unknown }>>;
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
    expect(spec.paths["/chatgpt/projects"].get.description).toContain("CodexLink projects");
    expect(content).toContain("git_available");
    expect(spec.paths["/chatgpt/projects/{projectId}/tree"].get.operationId).toBe("getProjectTree");
    expect(spec.paths["/chatgpt/projects/{projectId}/files/search"].get.operationId).toBe("searchProjectFiles");
    expect(spec.paths["/chatgpt/projects/{projectId}/file"].get.operationId).toBe("readProjectFile");
    expect(spec.paths["/chatgpt/projects/{projectId}/grep"].get.operationId).toBe("searchProjectText");
    expect(spec.paths["/chatgpt/projects/{projectId}/select"].post.operationId).toBe("selectProject");
    expect(spec.paths["/chatgpt/active-project"].get.operationId).toBe("getActiveProject");
    expect(spec.paths["/chatgpt/projects/{projectId}/inspect"].get.operationId).toBe("inspectProject");
    expect(spec.paths["/chatgpt/projects/{projectId}/codex-changes"].get.operationId).toBe("getCodexChanges");
    expect(spec.paths["/chatgpt/projects/{projectId}/review-packet"].get.operationId).toBe("getReviewPacket");
  });

  it("does not include secrets or claim HTTP MCP", () => {
    const content = fs.readFileSync(specPath, "utf8");
    const spec = JSON.parse(content) as { paths: Record<string, unknown> };

    expect(Object.keys(spec.paths)).not.toContain("/mcp");
    expect(Object.keys(spec.paths).some((pathName) => pathName.includes("scan"))).toBe(false);
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
    expect(Object.keys(spec.paths).some((pathName) => pathName.includes("scan"))).toBe(false);
    expect(Object.keys(spec.paths)).toEqual([
      "/chatgpt/projects",
      "/chatgpt/active-project",
      "/chatgpt/projects/{projectId}/tree",
      "/chatgpt/projects/{projectId}/files/search",
      "/chatgpt/projects/{projectId}/file",
      "/chatgpt/projects/{projectId}/grep",
      "/chatgpt/projects/{projectId}/select",
      "/chatgpt/projects/{projectId}/inspect",
      "/chatgpt/projects/{projectId}/codex-changes",
      "/chatgpt/projects/{projectId}/review-packet"
    ]);

    expect(spec.paths["/chatgpt/projects"].get.operationId).toBe("listProjects");
    expect(spec.paths["/chatgpt/projects"].get.description).toContain("CodexLink projects");
    expect(JSON.stringify(spec.paths["/chatgpt/projects"].get)).toContain("git_available");
    expect(spec.paths["/chatgpt/projects/{projectId}/tree"].get.operationId).toBe("getProjectTree");
    expect(spec.paths["/chatgpt/projects/{projectId}/files/search"].get.operationId).toBe("searchProjectFiles");
    expect(spec.paths["/chatgpt/projects/{projectId}/file"].get.operationId).toBe("readProjectFile");
    expect(spec.paths["/chatgpt/projects/{projectId}/grep"].get.operationId).toBe("searchProjectText");
    expect(spec.paths["/chatgpt/projects/{projectId}/select"].post.operationId).toBe("selectProject");
    expect(spec.paths["/chatgpt/active-project"].get.operationId).toBe("getActiveProject");
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

  it("keeps operation descriptions within GPT Actions length limits", () => {
    for (const filePath of [specPath, gptActionsSpecPath]) {
      const spec = JSON.parse(fs.readFileSync(filePath, "utf8")) as OpenApiSpec;
      for (const operation of operations(spec)) {
        expect(typeof operation.description).toBe("string");
        expect(operation.description?.length).toBeLessThanOrEqual(300);
      }
    }
  });

  it("documents the expanded getProjectTree entry budget", () => {
    for (const filePath of [specPath, gptActionsSpecPath]) {
      const spec = JSON.parse(fs.readFileSync(filePath, "utf8")) as OpenApiSpec;
      const treeOperation = spec.paths["/chatgpt/projects/{projectId}/tree"].get;
      const maxEntries = parameterByName(treeOperation, "max_entries");

      expect(maxEntries).toBeDefined();
      expect(maxEntries?.schema).toMatchObject({
        type: "integer",
        minimum: 1,
        maximum: 10000
      });
    }
  });
});
