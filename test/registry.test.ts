import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../src/core.js";
import { createPairingInfo } from "../src/pairing.js";
import {
  listProjects,
  formatProjectList,
  readProjectRegistry,
  registerCurrentProject,
  registerProject,
  registryPath,
  removeProject,
  validateProjectId
} from "../src/registry.js";

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("project registry", () => {
  it("registers, lists, and removes projects from the local registry", () => {
    const registryRoot = makeTempRoot("agentbridge-registry-home-");
    const projectRoot = makeTempRoot("agentbridge-registry-project-");
    initProject(projectRoot);

    const project = registerProject(registryRoot, "AgentBridge", projectRoot);

    expect(project.id).toBe("AgentBridge");
    expect(project.root).toBe(path.resolve(projectRoot));
    expect(project.source).toBe("manual");
    expect(project.type).toBe("folder");
    expect(listProjects(registryRoot)).toHaveLength(1);
    expect(registryPath(registryRoot)).toBe(path.join(registryRoot, ".agentbridge", "projects.json"));
    expect(readProjectRegistry(registryRoot)).toMatchObject({ version: 1 });
    expect(removeProject(registryRoot, "AgentBridge")).toBe(true);
    expect(listProjects(registryRoot)).toHaveLength(0);
    expect(fs.existsSync(projectRoot)).toBe(true);
  });

  it("register-current uses the current root and optional safe id", () => {
    const root = makeTempRoot("agentbridge-register-current-");

    const project = registerCurrentProject(root, "CurrentProject");

    expect(project.id).toBe("CurrentProject");
    expect(project.root).toBe(path.resolve(root));
    expect(project.source).toBe("current");
    expect(listProjects(root)[0].id).toBe("CurrentProject");
  });

  it("updates an existing project when the same id is registered again", () => {
    const registryRoot = makeTempRoot("agentbridge-registry-dup-");
    const projectA = makeTempRoot("agentbridge-project-a-");
    const projectB = makeTempRoot("agentbridge-project-b-");

    const first = registerProject(registryRoot, "SharedId", projectA);
    while (Date.now() === Date.parse(first.updated_at)) {
      // Ensure updated_at can differ even on fast filesystems.
    }
    const second = registerProject(registryRoot, "SharedId", projectB);

    expect(listProjects(registryRoot)).toHaveLength(1);
    expect(second.created_at).toBe(first.created_at);
    expect(second.root).toBe(path.resolve(projectB));
    expect(second.updated_at).not.toBe(first.updated_at);
  });

  it("rejects unsafe ids and invalid roots", () => {
    const registryRoot = makeTempRoot("agentbridge-registry-invalid-");
    const missing = path.join(registryRoot, "missing");

    for (const id of ["", "../secret", "D:\\AgentBridge", "C:", "https://example.com", "bad/id", "bad\\id"]) {
      expect(() => validateProjectId(id)).toThrow();
    }

    expect(() => registerProject(registryRoot, "Missing", missing)).toThrow("does not exist");
    expect(() => registerProject(registryRoot, "DriveRoot", path.parse(path.resolve(registryRoot)).root)).toThrow(
      "unsafe project root"
    );
    if (process.env.LOCALAPPDATA) {
      expect(() => registerProject(registryRoot, "AppData", process.env.LOCALAPPDATA as string)).toThrow("unsafe project root");
    }
  });

  it("remove handles missing projects safely", () => {
    const registryRoot = makeTempRoot("agentbridge-registry-remove-missing-");

    expect(removeProject(registryRoot, "MissingProject")).toBe(false);
    expect(listProjects(registryRoot)).toEqual([]);
  });

  it("does not store token or auth fields in registry entries", () => {
    const registryRoot = makeTempRoot("agentbridge-registry-secret-");
    const projectRoot = makeTempRoot("agentbridge-project-secret-");
    fs.mkdirSync(path.join(projectRoot, ".agentbridge"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".agentbridge", "local_token"), "local-token-value-123", "utf8");

    registerProject(registryRoot, "SecretSafe", projectRoot);
    const serialized = fs.readFileSync(registryPath(registryRoot), "utf8");

    expect(serialized).not.toContain("local-token-value-123");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("OPENAI_API_KEY");
  });

  it("formats stale registry entries without crashing", () => {
    const registryRoot = makeTempRoot("agentbridge-registry-stale-");
    const missingRoot = path.join(registryRoot, "missing-project");
    fs.mkdirSync(path.join(registryRoot, ".agentbridge"), { recursive: true });
    fs.writeFileSync(
      registryPath(registryRoot),
      JSON.stringify(
        {
          version: 1,
          projects: [
            {
              id: "StaleProject",
              name: "StaleProject",
              root: missingRoot,
              type: "folder",
              source: "manual",
              created_at: "2026-06-02T00:00:00.000Z",
              updated_at: "2026-06-02T00:00:00.000Z",
              last_seen: "2026-06-02T00:00:00.000Z"
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const output = formatProjectList(listProjects(registryRoot), registryRoot);

    expect(output).toContain("StaleProject");
    expect(output).toContain("Git");
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
