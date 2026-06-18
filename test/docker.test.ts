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
    expect(dockerfile).toContain("CODEXLINK_PUBLIC_URL is required");
    expect(dockerfile).not.toContain("local_token");
    expect(dockerfile).not.toContain("OPENAI_API_KEY");
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
