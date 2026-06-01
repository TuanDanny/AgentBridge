import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../src/core.js";
import { createPairingInfo } from "../src/pairing.js";
import { addProject, listProjects, registryPath, removeProject } from "../src/registry.js";

const tempRoots: string[] = [];
const originalHome = process.env.AGENTBRIDGE_HOME;

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  process.env.AGENTBRIDGE_HOME = originalHome;
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("project registry", () => {
  it("adds, lists, and removes projects from the configured registry", () => {
    const registryHome = makeTempRoot("agentbridge-registry-home-");
    const projectRoot = makeTempRoot("agentbridge-registry-project-");
    process.env.AGENTBRIDGE_HOME = registryHome;
    initProject(projectRoot);

    const project = addProject(projectRoot);

    expect(project.project_root).toBe(path.resolve(projectRoot));
    expect(listProjects()).toHaveLength(1);
    expect(registryPath()).toContain(registryHome);
    expect(removeProject(projectRoot)).toBe(true);
    expect(listProjects()).toHaveLength(0);
  });
});

describe("pairing", () => {
  it("creates a dashboard URL and QR text on demand", () => {
    const root = makeTempRoot("agentbridge-pairing-");
    initProject(root);

    const pairing = createPairingInfo(root, { host: "192.168.1.10", port: 7777, qr: true });

    expect(pairing.dashboardUrl).toBe("http://192.168.1.10:7777/dashboard");
    expect(pairing.token.length).toBeGreaterThan(20);
    expect(pairing.qr).toBeTruthy();
  });
});
