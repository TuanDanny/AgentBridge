import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(".");

describe("hosted relay container", () => {
  it("uses a non-root multi-stage runtime with a relay healthcheck", () => {
    const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");

    expect(dockerfile).toContain("FROM node:22-alpine AS build");
    expect(dockerfile).toContain("FROM node:22-alpine AS runtime");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain("/relay/health");
    expect(dockerfile).toContain("relay hosted serve");
    expect(dockerfile).toContain("openapi.codexlink.relay.gpt-actions.json");
    expect(dockerfile).toContain("CODEXLINK_PUBLIC_URL:-auto");
    expect(dockerfile).not.toContain("local_token");
    expect(dockerfile).not.toContain("OPENAI_API_KEY");
  });

  it("ships a Singapore Render Blueprint with stable proxy-origin configuration", () => {
    const render = fs.readFileSync(path.join(root, "render.yaml"), "utf8");

    expect(render).toContain("runtime: docker");
    expect(render).toContain("region: singapore");
    expect(render).toContain("plan: starter");
    expect(render).toContain("healthCheckPath: /relay/health");
    expect(render).toContain("CODEXLINK_PUBLIC_URL");
    expect(render).toContain("CODEXLINK_TRUST_PROXY");
    expect(render).not.toContain("local_token");
    expect(render).not.toContain("OPENAI_API_KEY");
  });

  it("hardens the compose service and does not mount workspace content", () => {
    const compose = fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8");

    expect(compose).toContain("read_only: true");
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).toContain("cap_drop:");
    expect(compose).not.toContain("volumes:");
    expect(compose).not.toContain("local_token");
    expect(compose).not.toContain("OPENAI_API_KEY");
  });

  it("excludes local runtime, secrets, and development output from build context", () => {
    const ignore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8");

    for (const entry of [".git", ".agentbridge", "node_modules", "dist", ".env", ".env.*", "test"]) {
      expect(ignore.split(/\r?\n/)).toContain(entry);
    }
  });
});
