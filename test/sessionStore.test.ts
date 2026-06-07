import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendSessionActivity,
  appendSessionCheck,
  appendSessionEvidence,
  addSessionHandoff,
  appendSessionEvent,
  bootstrapSession,
  getActivitySinceRevision,
  getRecentActivity,
  getRecentChecks,
  getRecentEvidence,
  getOrCreateActiveSession,
  getSessionSummary,
  getSessionUpdates,
  setSessionGoal,
  updateSessionHandoff
} from "../src/sessionStore.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-session-store-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("shared session store", () => {
  it("bootstraps missing sessions, returns compact context, and avoids event spam within TTL", () => {
    const root = makeTempRoot();
    const projectId = "AgentAI";
    const token = `sk-${"e".repeat(32)}`;

    const first = bootstrapSession(root, projectId, {
      actor: "codex",
      client: "codex",
      adapter: "mcp",
      source: `codex_plugin token=${token}`,
      mode: "start"
    });
    expect(first).toMatchObject({
      ok: true,
      project_id: projectId,
      revision: 2,
      bootstrapped: true,
      bootstrap_event_created: true,
      current_goal: "Shared workspace session is ready.",
      phase: "planning",
      status: "active",
      recommended_next_action: "set_goal_or_ask_user"
    });
    expect(first.open_handoffs).toEqual([]);
    expect(first.recent_evidence).toEqual([]);
    expect(first.recent_checks).toEqual([]);
    expect(first.active_clients).toHaveLength(1);
    expect(first.active_clients[0]).toMatchObject({
      client: "codex",
      adapter: "mcp",
      last_tool: "session_bootstrap",
      status: "active",
      last_bootstrap_revision: 2
    });
    expect(first.recent_events.at(-1)?.summary).toBe("Codex session started");
    expect(JSON.stringify(first)).not.toContain(token);

    const second = bootstrapSession(root, projectId, {
      actor: "codex",
      client: "codex",
      adapter: "mcp",
      source: `codex_plugin token=${token}`,
      mode: "start"
    });
    expect(second.revision).toBe(first.revision);
    expect(second.bootstrap_event_created).toBe(false);
    expect(second.active_clients).toHaveLength(1);
    expect(second.active_clients[0].last_bootstrap_revision).toBe(first.revision);

    const summary = getSessionSummary(root, projectId);
    expect(summary.revision).toBe(2);
    expect(summary.active_clients).toHaveLength(1);
    expect(summary.recent_events.filter((event) => event.summary === "Codex session started")).toHaveLength(1);

    const sessionDir = path.join(root, ".agentbridge", "sessions", projectId, summary.session_id);
    const serialized = [
      fs.readFileSync(path.join(sessionDir, "events.jsonl"), "utf8"),
      fs.readFileSync(path.join(sessionDir, "state.json"), "utf8"),
      fs.readFileSync(path.join(sessionDir, "summary.json"), "utf8")
    ].join("\n");
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("token=");
    expect(serialized).not.toContain("OPENAI_API_KEY=");
  });

  it("recommends acknowledging open Codex handoffs during bootstrap", () => {
    const root = makeTempRoot();
    const projectId = "AgentAI";
    addSessionHandoff(root, projectId, {
      from: "chatgpt",
      to: "codex",
      title: "Review handoff",
      message: "Please continue from the shared session."
    });

    const result = bootstrapSession(root, projectId, {
      actor: "codex",
      client: "codex",
      adapter: "cli",
      source: "cli"
    });

    expect(result.bootstrap_event_created).toBe(true);
    expect(result.open_handoffs).toHaveLength(1);
    expect(result.open_handoffs[0]).toMatchObject({ to: "codex", status: "open" });
    expect(result.recommended_next_action).toBe("acknowledge_open_handoff");
  });

  it("creates sessions, appends events and handoffs, updates summaries, and redacts secrets", () => {
    const root = makeTempRoot();
    const projectId = "AgentBridge";
    const token = `sk-${"a".repeat(32)}`;

    const created = getOrCreateActiveSession(root, projectId);
    expect(created.active_session).toMatchObject({
      project_id: projectId,
      revision: 1
    });
    expect(created.session.safety).toMatchObject({
      store_raw_file_content: false,
      store_secrets: false,
      allow_auto_push: false,
      allow_auto_release: false,
      allow_arbitrary_shell: false
    });
    expect(created.summary.revision).toBe(1);
    expect(fs.existsSync(path.join(root, ".agentbridge", "sessions", projectId, "active_session.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".agentbridge", "sessions", projectId, created.session.session_id, "events.jsonl"))).toBe(true);

    const longDetails = `OPENAI_API_KEY=${token}\n${"x".repeat(2500)}`;
    const event = appendSessionEvent(root, projectId, {
      actor: "codex",
      type: "note",
      summary: `Started session with ${token}`,
      details: longDetails,
      expected_revision: 1
    });
    expect(event.revision).toBe(2);
    expect(event.event.redacted).toBe(true);
    expect(event.event.truncated).toBe(true);
    expect(event.event.summary).toContain("[REDACTED]");
    expect(event.event.summary).not.toContain(token);

    const handoff = addSessionHandoff(root, projectId, {
      from: "chatgpt",
      to: "codex",
      title: "Implement shared session",
      message: `Do not leak Authorization: Bearer ${"b".repeat(32)}`,
      constraints: ["No release", `token=${token}`],
      expected_output: ["files changed", "tests run"],
      expected_revision: 2
    });
    expect(handoff.revision).toBe(3);
    expect(handoff.handoff.status).toBe("open");
    expect(handoff.handoff.redacted).toBe(true);
    expect(JSON.stringify(handoff)).not.toContain(token);

    const updated = updateSessionHandoff(root, projectId, handoff.handoff.id, {
      actor: "codex",
      status: "acknowledged",
      result_summary: `Acknowledged with PASSWORD=${token}`,
      expected_revision: 3
    });
    expect(updated.revision).toBe(4);
    expect(updated.handoff.status).toBe("acknowledged");
    expect(updated.handoff.result_summary).toContain("[REDACTED]");

    const goal = setSessionGoal(root, projectId, {
      actor: "codex",
      goal: "Build v0.6 shared session memory.",
      phase: "implementation",
      status: "in_progress",
      expected_revision: 4
    });
    expect(goal.revision).toBe(5);

    const summary = getSessionSummary(root, projectId);
    expect(summary.revision).toBe(5);
    expect(summary.current_goal).toBe("Build v0.6 shared session memory.");
    expect(summary.current_status).toBe("in_progress");
    expect(summary.phase).toBe("implementation");
    expect(summary.recent_events.map((item) => item.id)).toContain(event.event.id);
    expect(summary.open_handoffs[0]).toMatchObject({
      id: handoff.handoff.id,
      status: "acknowledged"
    });

    const updates = getSessionUpdates(root, projectId, 2);
    expect(updates.from_revision).toBe(2);
    expect(updates.to_revision).toBe(5);
    expect(updates.events.every((item) => item.revision > 2)).toBe(true);
    expect(updates.handoffs.every((item) => item.revision > 2)).toBe(true);

    const sessionText = fs.readFileSync(path.join(root, ".agentbridge", "sessions", projectId, created.session.session_id, "events.jsonl"), "utf8");
    const handoffText = fs.readFileSync(path.join(root, ".agentbridge", "sessions", projectId, created.session.session_id, "handoffs.jsonl"), "utf8");
    const serialized = `${sessionText}\n${handoffText}`;
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("Authorization: Bearer b");
    expect(serialized).not.toContain("OPENAI_API_KEY=");
  });

  it("rejects invalid enum values and revision conflicts", () => {
    const root = makeTempRoot();
    getOrCreateActiveSession(root, "AgentBridge");

    expect(() =>
      appendSessionEvent(root, "AgentBridge", {
        actor: "codex",
        type: "note",
        summary: "First event",
        expected_revision: 99
      })
    ).toThrow("revision conflict");
    expect(() =>
      appendSessionEvent(root, "AgentBridge", {
        actor: "codex",
        type: "invalid" as never,
        summary: "Invalid event"
      })
    ).toThrow("event type");
    expect(() =>
      updateSessionHandoff(root, "AgentBridge", "handoff_000001", {
        status: "invalid" as never
      })
    ).toThrow("status");
  });

  it("stores evidence and checks as redacted metadata without raw content", () => {
    const root = makeTempRoot();
    const projectId = "AgentBridge";
    const token = `sk-${"c".repeat(32)}`;
    getOrCreateActiveSession(root, projectId);

    const evidence = appendSessionEvidence(root, projectId, {
      actor: "chatgpt",
      kind: "file_read",
      source: "http",
      path: "src/example.ts",
      status: "partial",
      purpose: `review OPENAI_API_KEY=${token}`,
      metadata: {
        read_status: "partial",
        bytes_returned: 123,
        truncated: true,
        content: `UNIQUE_RAW_CONTENT_VALUE ${token}`,
        snippet: `snippet ${token}`,
        stdout: "long terminal output that must not be stored",
        stderr: "error output that must not be stored",
        raw_output: "raw output that must not be stored",
        terminal_output: "terminal output that must not be stored",
        body: "body text that must not be stored",
        patch: "diff --git a/file b/file",
        query: `token=${token}`,
        nested: {
          secret: `Bearer ${"d".repeat(32)}`
        }
      }
    });
    expect(evidence.revision).toBe(2);
    expect(evidence.evidence.redacted).toBe(true);
    expect(evidence.evidence.metadata).not.toHaveProperty("content");
    expect(evidence.evidence.metadata).not.toHaveProperty("snippet");
    expect(evidence.evidence.metadata).not.toHaveProperty("stdout");
    expect(evidence.evidence.metadata).not.toHaveProperty("stderr");
    expect(evidence.evidence.metadata).not.toHaveProperty("raw_output");
    expect(evidence.evidence.metadata).not.toHaveProperty("terminal_output");
    expect(evidence.evidence.metadata).not.toHaveProperty("body");
    expect(evidence.evidence.metadata).not.toHaveProperty("patch");

    const check = appendSessionCheck(root, projectId, {
      actor: "codex",
      type: "test",
      command: `npm test --token=${token}`,
      status: "pass",
      exit_code: 0,
      summary: `96 tests passed with PASSWORD=${token}`,
      duration_ms: 1234
    });
    expect(check.revision).toBe(3);
    expect(check.check.summary).toContain("[REDACTED]");

    const summary = getSessionSummary(root, projectId);
    expect(summary.recent_evidence).toHaveLength(1);
    expect(summary.recent_checks).toHaveLength(1);

    const updates = getSessionUpdates(root, projectId, 1);
    expect(updates.evidence).toHaveLength(1);
    expect(updates.checks).toHaveLength(1);

    expect(getRecentEvidence(root, projectId).evidence[0].kind).toBe("file_read");
    expect(getRecentChecks(root, projectId).checks[0].type).toBe("test");

    const sessionDir = path.join(root, ".agentbridge", "sessions", projectId, getOrCreateActiveSession(root, projectId).session.session_id);
    const serialized = [
      fs.readFileSync(path.join(sessionDir, "evidence.jsonl"), "utf8"),
      fs.readFileSync(path.join(sessionDir, "checks.jsonl"), "utf8"),
      fs.readFileSync(path.join(sessionDir, "summary.json"), "utf8")
    ].join("\n");
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("UNIQUE_RAW_CONTENT_VALUE");
    expect(serialized).not.toContain("snippet ");
    expect(serialized).not.toContain("terminal output that must not be stored");
    expect(serialized).not.toContain("diff --git");
    expect(serialized).not.toContain("Bearer d");
    expect(serialized).not.toContain("OPENAI_API_KEY=");
  });

  it("stores redacted activity timeline metadata and exposes recent activity in summaries", () => {
    const root = makeTempRoot();
    const projectId = "AgentBridge";
    const token = `sk-${"e".repeat(32)}`;
    getOrCreateActiveSession(root, projectId);

    const first = appendSessionActivity(root, projectId, {
      actor: "codex",
      source: "cli",
      kind: "file_create",
      status: "success",
      summary: `Created file with OPENAI_API_KEY=${token}`,
      task_id: "task_000001",
      correlation_id: "notes/activity.txt",
      paths: ["notes/activity.txt"],
      metadata: {
        git_status: "untracked",
        bytes: 42,
        content: `RAW_FILE_CONTENT_SHOULD_NOT_STORE ${token}`,
        stdout: "RAW_TERMINAL_OUTPUT_SHOULD_NOT_STORE",
        patch: "diff --git a/notes/activity.txt b/notes/activity.txt",
        oversized: "x".repeat(5000)
      }
    });
    const second = appendSessionActivity(root, projectId, {
      actor: "codex",
      source: "cli",
      kind: "file_verify",
      status: "success",
      summary: "Verified file metadata only",
      paths: ["notes/activity.txt"],
      related: {
        activity_id: first.activity.id
      },
      metadata: {
        sha256: "abc123",
        raw_content_stored: false
      }
    });

    expect(first.activity.id).toBe("act_000001");
    expect(first.activity.seq).toBe(1);
    expect(first.activity.revision_before).toBe(1);
    expect(first.activity.revision_after).toBe(2);
    expect(first.activity.summary).toContain("[REDACTED]");
    expect(first.activity.redacted).toBe(true);
    expect(first.activity.truncated).toBe(true);
    expect(first.activity.metadata).not.toHaveProperty("content");
    expect(first.activity.metadata).not.toHaveProperty("stdout");
    expect(first.activity.metadata).not.toHaveProperty("patch");
    expect(second.activity.id).toBe("act_000002");
    expect(second.activity.seq).toBe(2);

    const recent = getRecentActivity(root, projectId, 1);
    expect(recent.activities).toHaveLength(1);
    expect(recent.activities[0].id).toBe(second.activity.id);
    expect(recent.has_more).toBe(true);

    const since = getActivitySinceRevision(root, projectId, 1);
    expect(since.activities.map((item) => item.id)).toEqual(["act_000001", "act_000002"]);

    const summary = getSessionSummary(root, projectId);
    expect(summary.recent_activity.map((item) => item.id)).toEqual(["act_000001", "act_000002"]);
    expect(summary.activity_counts.file_create).toBe(1);
    expect(summary.activity_counts.file_verify).toBe(1);
    expect(summary.warnings).toContain("Some recent activity metadata was redacted or truncated.");

    const sessionDir = path.join(root, ".agentbridge", "sessions", projectId, getOrCreateActiveSession(root, projectId).session.session_id);
    const activityPath = path.join(sessionDir, "activity.jsonl");
    expect(fs.existsSync(activityPath)).toBe(true);
    const serialized = [fs.readFileSync(activityPath, "utf8"), fs.readFileSync(path.join(sessionDir, "summary.json"), "utf8")].join("\n");
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("RAW_FILE_CONTENT_SHOULD_NOT_STORE");
    expect(serialized).not.toContain("RAW_TERMINAL_OUTPUT_SHOULD_NOT_STORE");
    expect(serialized).not.toContain("diff --git");
    expect(serialized).not.toContain("OPENAI_API_KEY=");
  });

  it("keeps session runtime files ignored by git", () => {
    const ignored = execFileSync("git", ["check-ignore", "-v", ".agentbridge/sessions/AgentBridge/active_session.json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true
    });

    expect(ignored).toContain(".agentbridge/");
  });
});
