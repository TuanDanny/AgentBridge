import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const specPath = path.resolve("openapi.agentbridge.json");

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
});
