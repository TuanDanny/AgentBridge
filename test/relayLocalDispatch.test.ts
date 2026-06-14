import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerCurrentProject, registerProject } from "../src/registry.js";
import { appendSessionActivity, bootstrapSession } from "../src/sessionStore.js";
import { createRelayEnvelope, dispatchRelayRequestLocally } from "../src/relayLocalDispatch.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-relay-dispatch-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("relay local dispatcher", () => {
  it("lists fallback project metadata without exposing raw root", () => {
    const root = makeTempRoot();
    const result = dispatchRelayRequestLocally(root, createRelayEnvelope("listProjects"));

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.data)).toContain("current_project_fallback");
    expect(JSON.stringify(result.data)).not.toContain(root);
    expect(result.metadata).toMatchObject({
      validated: true,
      local_only: true,
      content_stored: false
    });
  });

  it("dispatches registered project session summary, context, and timeline metadata", () => {
    const root = makeTempRoot();
    registerCurrentProject(root, "RelayProject");
    bootstrapSession(root, "RelayProject", { actor: "codex", client: "codex", adapter: "cli", source: "relay_dispatch_test" });
    appendSessionActivity(root, "RelayProject", {
      actor: "codex",
      source: "cli",
      kind: "task_progress",
      status: "success",
      summary: "Relay dispatcher test activity",
      task_id: "relay-task-1"
    });

    const summary = dispatchRelayRequestLocally(root, createRelayEnvelope("getSessionSummary", "RelayProject"));
    const context = dispatchRelayRequestLocally(root, createRelayEnvelope("getSessionContext", "RelayProject"));
    const timeline = dispatchRelayRequestLocally(
      root,
      createRelayEnvelope("getSessionTimeline", "RelayProject", { mode: "task", task_id: "relay-task-1", limit: 5 })
    );

    expect(summary.ok).toBe(true);
    expect(JSON.stringify(summary.data)).toContain("RelayProject");
    expect(context.ok).toBe(true);
    expect(JSON.stringify(context.data)).toContain("recent_activity");
    expect(timeline.ok).toBe(true);
    expect(JSON.stringify(timeline.data)).toContain("Relay dispatcher test activity");
    expect(JSON.stringify({ summary, context, timeline })).not.toContain(root);
    expect(JSON.stringify({ summary, context, timeline })).not.toContain("local_token");
    expect(JSON.stringify({ summary, context, timeline })).not.toContain("Bearer ");
  });

  it("dispatches inspector and safe project file metadata through the relay allowlist", () => {
    const root = makeTempRoot();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "relay-dispatch-fixture" }, null, 2));
    fs.writeFileSync(path.join(root, "README.md"), "# Relay Dispatch Fixture\n\nsessionStore marker\n");
    registerCurrentProject(root, "RelayProject");
    bootstrapSession(root, "RelayProject", { actor: "codex", client: "codex", adapter: "cli", source: "relay_dispatch_test" });

    const inspect = dispatchRelayRequestLocally(root, createRelayEnvelope("inspectProject", "RelayProject"));
    const changes = dispatchRelayRequestLocally(root, createRelayEnvelope("getCodexChanges", "RelayProject"));
    const review = dispatchRelayRequestLocally(root, createRelayEnvelope("getReviewPacket", "RelayProject"));
    const tree = dispatchRelayRequestLocally(root, createRelayEnvelope("getProjectTree", "RelayProject", { max_entries: 20 }));
    const files = dispatchRelayRequestLocally(root, createRelayEnvelope("searchProjectFiles", "RelayProject", { q: "README" }));
    const read = dispatchRelayRequestLocally(root, createRelayEnvelope("readProjectFile", "RelayProject", { path: "README.md", max_chars: 200 }));
    const grep = dispatchRelayRequestLocally(root, createRelayEnvelope("searchProjectText", "RelayProject", { q: "sessionStore", max_matches: 5 }));

    for (const result of [inspect, changes, review, tree, files, read, grep]) {
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.metadata).toMatchObject({ validated: true, local_only: true, content_stored: false });
    }
    expect(JSON.stringify(tree.data)).toContain("recommended_next_reads");
    expect(JSON.stringify(files.data)).toContain("README.md");
    expect(JSON.stringify(read.data)).toContain("Relay Dispatch Fixture");
    expect(JSON.stringify(grep.data)).toContain("sessionStore");
    expect(JSON.stringify({ inspect, changes, review, tree, files, read, grep })).not.toContain(root);
    expect(JSON.stringify({ inspect, changes, review, tree, files, read, grep })).not.toContain("local_token");
  });

  it("rejects unknown projects, raw paths, and non-allowlisted relay operations", () => {
    const root = makeTempRoot();
    registerCurrentProject(root, "RelayProject");

    const unknownProject = dispatchRelayRequestLocally(root, createRelayEnvelope("getSessionSummary", "NotRegistered"));
    const rawPath = dispatchRelayRequestLocally(root, {
      operation_id: "getSessionSummary",
      method: "GET",
      path: "/chatgpt/projects/D:/AgentBridge/session/summary",
      project_id: "D:/AgentBridge"
    });
    const mcp = dispatchRelayRequestLocally(root, {
      operation_id: "getSessionSummary",
      method: "GET",
      path: "/mcp",
      project_id: "RelayProject"
    });

    expect(unknownProject.ok).toBe(false);
    expect(unknownProject.status).toBe(404);
    expect(rawPath.ok).toBe(false);
    expect(mcp.ok).toBe(false);
  });

  it("filters relay project listing and dispatch by the local client allowed project list", () => {
    const root = makeTempRoot();
    const otherRoot = path.join(root, "other");
    fs.mkdirSync(otherRoot);
    fs.writeFileSync(path.join(root, "README.md"), "allowed project\n");
    fs.writeFileSync(path.join(otherRoot, "README.md"), "other project\n");
    registerCurrentProject(root, "AllowedProject");
    registerProject(root, "OtherProject", otherRoot);

    const listed = dispatchRelayRequestLocally(root, createRelayEnvelope("listProjects"), { allowedProjectIds: ["AllowedProject"] });
    expect(listed.ok).toBe(true);
    expect(JSON.stringify(listed.data)).toContain("AllowedProject");
    expect(JSON.stringify(listed.data)).not.toContain("OtherProject");

    const allowed = dispatchRelayRequestLocally(
      root,
      createRelayEnvelope("readProjectFile", "AllowedProject", { path: "README.md" }),
      { allowedProjectIds: ["AllowedProject"] }
    );
    const blocked = dispatchRelayRequestLocally(
      root,
      createRelayEnvelope("readProjectFile", "OtherProject", { path: "README.md" }),
      { allowedProjectIds: ["AllowedProject"] }
    );

    expect(allowed.ok).toBe(true);
    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe(404);
  });
});
