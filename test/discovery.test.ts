import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverProjects,
  findProjectMarkers,
  isIgnoredDirectory,
  makeSafeProjectId,
  parseScanSelection,
  validateScanRoot
} from "../src/discovery.js";
import { listProjects, registerProject, registryPath } from "../src/registry.js";

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function mkdirProject(root: string, name: string, markers: Record<string, string> = {}): string {
  const projectRoot = path.join(root, name);
  fs.mkdirSync(projectRoot, { recursive: true });
  for (const [marker, content] of Object.entries(markers)) {
    fs.writeFileSync(path.join(projectRoot, marker), content, "utf8");
  }
  return projectRoot;
}

function initGit(root: string): void {
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore", windowsHide: true });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("safe project discovery", () => {
  it("detects git and package project markers", () => {
    const scanRoot = makeTempRoot("agentbridge-scan-markers-");
    const projectA = mkdirProject(scanRoot, "ProjectA", { "package.json": "{\"name\":\"project-a\"}\n" });
    initGit(projectA);
    mkdirProject(scanRoot, "ProjectB", { "pyproject.toml": "[project]\nname = \"project-b\"\n" });

    const candidates = discoverProjects(scanRoot, { maxDepth: 2, maxProjects: 10 });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["ProjectA", "ProjectB"]);
    expect(candidates[0].markers).toContain(".git");
    expect(candidates[0].markers).toContain("package.json");
    expect(candidates[0].git_available).toBe(true);
    expect(candidates[0].package_name).toBe("project-a");
    expect(candidates[1].markers).toContain("pyproject.toml");
  });

  it("ignores node_modules and .git descendants", () => {
    const scanRoot = makeTempRoot("agentbridge-scan-ignore-");
    mkdirProject(scanRoot, "Project", { "package.json": "{\"name\":\"real\"}\n" });
    fs.mkdirSync(path.join(scanRoot, "node_modules", "FakeProject"), { recursive: true });
    fs.writeFileSync(path.join(scanRoot, "node_modules", "FakeProject", "package.json"), "{}", "utf8");
    fs.mkdirSync(path.join(scanRoot, "Project", ".git", "NestedProject"), { recursive: true });
    fs.writeFileSync(path.join(scanRoot, "Project", ".git", "NestedProject", "package.json"), "{}", "utf8");

    const candidates = discoverProjects(scanRoot, { maxDepth: 4, maxProjects: 10 });

    expect(isIgnoredDirectory("node_modules")).toBe(true);
    expect(isIgnoredDirectory(".git")).toBe(true);
    expect(candidates.map((candidate) => candidate.id)).toEqual(["Project"]);
  });

  it("respects max-depth", () => {
    const scanRoot = makeTempRoot("agentbridge-scan-depth-");
    mkdirProject(path.join(scanRoot, "level1"), "DeepProject", { "package.json": "{}" });

    expect(discoverProjects(scanRoot, { maxDepth: 1, maxProjects: 10 })).toHaveLength(0);
    expect(discoverProjects(scanRoot, { maxDepth: 2, maxProjects: 10 })).toHaveLength(1);
  });

  it("respects max-projects", () => {
    const scanRoot = makeTempRoot("agentbridge-scan-limit-");
    mkdirProject(scanRoot, "A", { "package.json": "{}" });
    mkdirProject(scanRoot, "B", { "package.json": "{}" });
    mkdirProject(scanRoot, "C", { "package.json": "{}" });

    const candidates = discoverProjects(scanRoot, { maxDepth: 1, maxProjects: 2 });

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.id)).toEqual(["A", "B"]);
  });

  it("rejects dangerous and missing scan roots", () => {
    const tempRoot = makeTempRoot("agentbridge-scan-root-");
    const driveOrFilesystemRoot = path.parse(path.resolve(tempRoot)).root;

    expect(() => validateScanRoot(driveOrFilesystemRoot)).toThrow("Refusing to scan broad/system root");
    expect(() => validateScanRoot(path.join(tempRoot, "missing"))).toThrow("does not exist");
  });

  it("creates safe unique project ids", () => {
    const existing = new Set<string>();

    expect(makeSafeProjectId("@scope/weird project", existing)).toBe("scope-weird-project");
    expect(makeSafeProjectId("@scope/weird project", existing)).toBe("scope-weird-project-2");
    expect(makeSafeProjectId("../", existing)).toBe("project");
    expect(makeSafeProjectId("D:\\Unsafe\\Name", existing)).toBe("D-Unsafe-Name");
  });

  it("reads only project markers for marker discovery", () => {
    const scanRoot = makeTempRoot("agentbridge-scan-marker-read-");
    const projectRoot = mkdirProject(scanRoot, "Marked", { "package.json": "{}", ".env": "SECRET=value\n" });

    expect(findProjectMarkers(projectRoot)).toEqual(["package.json"]);
  });

  it("preview discovery does not write the registry", () => {
    const registryRoot = makeTempRoot("agentbridge-scan-preview-registry-");
    const scanRoot = makeTempRoot("agentbridge-scan-preview-");
    mkdirProject(scanRoot, "ProjectA", { "package.json": "{}" });

    expect(discoverProjects(scanRoot, { maxDepth: 1, maxProjects: 10 })).toHaveLength(1);
    expect(fs.existsSync(registryPath(registryRoot))).toBe(false);
  });

  it("registers selected and all scanned candidates with source scan", () => {
    const registryRoot = makeTempRoot("agentbridge-scan-register-");
    const scanRoot = makeTempRoot("agentbridge-scan-register-source-");
    mkdirProject(scanRoot, "ProjectA", { "package.json": "{}" });
    mkdirProject(scanRoot, "ProjectB", { "pyproject.toml": "" });
    const candidates = discoverProjects(scanRoot, { maxDepth: 1, maxProjects: 10 });
    const selected = parseScanSelection("1", candidates.length);

    for (const index of selected) {
      registerProject(registryRoot, candidates[index].id, candidates[index].root, "scan");
    }
    expect(listProjects(registryRoot).map((project) => project.id)).toEqual(["ProjectA"]);
    expect(listProjects(registryRoot)[0].source).toBe("scan");

    for (const candidate of candidates) {
      registerProject(registryRoot, candidate.id, candidate.root, "scan");
    }
    expect(listProjects(registryRoot).map((project) => project.id)).toEqual(["ProjectA", "ProjectB"]);
    expect(listProjects(registryRoot).every((project) => project.source === "scan")).toBe(true);
  });

  it("rejects invalid --select indexes", () => {
    expect(() => parseScanSelection("", 2)).toThrow("--select");
    expect(() => parseScanSelection("0", 2)).toThrow("Invalid --select index");
    expect(() => parseScanSelection("3", 2)).toThrow("Invalid --select index");
    expect(() => parseScanSelection("a", 2)).toThrow("Invalid --select index");
    expect(() => parseScanSelection("1,,2", 2)).toThrow("empty indexes");
  });

  it("does not store token or auth fields when scanned projects are registered", () => {
    const registryRoot = makeTempRoot("agentbridge-scan-secret-registry-");
    const scanRoot = makeTempRoot("agentbridge-scan-secret-");
    const projectRoot = mkdirProject(scanRoot, "SecretProject", { "package.json": "{}" });
    fs.mkdirSync(path.join(projectRoot, ".agentbridge"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".agentbridge", "local_token"), "local-token-value-123", "utf8");

    const [candidate] = discoverProjects(scanRoot, { maxDepth: 1, maxProjects: 10 });
    registerProject(registryRoot, candidate.id, candidate.root, "scan");
    const serialized = fs.readFileSync(registryPath(registryRoot), "utf8");

    expect(serialized).not.toContain("local-token-value-123");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("OPENAI_API_KEY");
  });
});
