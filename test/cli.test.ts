import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const tempRoots: string[] = [];
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function runCli(root: string, ...args: string[]): string {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
}

function runCliFailure(root: string, ...args: string[]): string {
  try {
    runCli(root, ...args);
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }
  throw new Error("Expected CLI command to fail.");
}

function run(root: string, command: string, args: string[] = []): string {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("compiled CLI smoke tests", () => {
  it("runs the Phase 1 workflow in an empty folder", () => {
    const root = makeTempRoot("agentbridge-cli-empty-");

    expect(runCli(root, "init")).toContain("AgentBridge");
    runCli(root, "capture", "--mode", "short");
    runCli(root, "prompt");
    runCli(root, "result");
    runCli(root, "review");
    const status = runCli(root, "status");

    expect(status).toContain("Status: review_ready");
    expect(fs.existsSync(path.join(root, ".agentbridge", "codex_prompt.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".agentbridge", "chatgpt_review.md"))).toBe(true);
  });

  it("captures staged and unstaged git changes while redacting token-like values", () => {
    const root = makeTempRoot("agentbridge-cli-git-");
    run(root, "git", ["init"]);
    run(root, "git", ["config", "user.email", "agentbridge@example.test"]);
    run(root, "git", ["config", "user.name", "AgentBridge Test"]);
    fs.writeFileSync(path.join(root, "app.txt"), "initial\n", "utf8");
    run(root, "git", ["add", "app.txt"]);
    run(root, "git", ["commit", "-m", "initial"]);

    fs.writeFileSync(path.join(root, "app.txt"), "OPENAI_API_KEY=sk-123456789012345678901234\n", "utf8");
    fs.writeFileSync(path.join(root, "staged.txt"), "staged\n", "utf8");
    run(root, "git", ["add", "staged.txt"]);

    runCli(root, "capture", "--mode", "full");

    const context = fs.readFileSync(path.join(root, ".agentbridge", "project_context.md"), "utf8");
    expect(context).toContain("app.txt");
    expect(context).toContain("staged.txt");
    expect(context).toContain("[REDACTED]");
    expect(context).not.toContain("sk-123456789012345678901234");
  });

  it("supports Codex dry-run handoff without launching Codex", () => {
    const root = makeTempRoot("agentbridge-cli-codex-");

    const output = runCli(root, "codex", "--run", "--dry-run", "--codex-command", "codex-test");

    expect(output).toContain("Dry run: codex-test");
    expect(fs.existsSync(path.join(root, ".agentbridge", "codex_prompt.md"))).toBe(true);
  });

  it("supports group companion CLI commands", () => {
    const root = makeTempRoot("agentbridge-cli-group-");

    expect(runCli(root, "group", "brief")).toContain("group_brief.md");
    expect(runCli(root, "group", "handoff")).toContain("group_handoff.md");
    expect(runCli(root, "group", "decision-template")).toContain("group_decision.md");
    const status = runCli(root, "group", "status");

    expect(status).toContain("Group brief exists: yes");
    expect(status).toContain("Group handoff exists: yes");
    expect(status).toContain("Group decision exists: yes");
  });

  it("supports secure tunnel CLI guide, register, and status commands", () => {
    const root = makeTempRoot("agentbridge-cli-tunnel-");

    const guide = runCli(root, "tunnel", "guide");
    expect(guide).toContain("cloudflared tunnel --url http://127.0.0.1:7777");
    expect(guide).toContain("ngrok http 7777");

    expect(runCli(root, "tunnel", "register", "https://example.trycloudflare.com")).toContain(
      "Registered tunnel URL"
    );
    const status = runCli(root, "tunnel", "status");
    const remote = fs.readFileSync(path.join(root, ".agentbridge", "remote_bridge.json"), "utf8");

    expect(status).toContain("Public URL: https://example.trycloudflare.com");
    expect(status).toContain("Token value: hidden");
    expect(remote).not.toContain("local_token");
  });

  it("supports project inspector CLI output modes", () => {
    const root = makeTempRoot("agentbridge-cli-inspect-");

    expect(runCli(root, "inspect")).toContain("AgentBridge Project Inspector");
    const json = JSON.parse(runCli(root, "inspect", "--json"));
    expect(json.ok).toBe(true);
    expect(json.project.name).toBe(path.basename(root));

    expect(runCli(root, "inspect", "--changes")).toContain("AgentBridge Codex Changes");
    expect(runCli(root, "inspect", "--for-chatgpt")).toContain("project_inspect_packet.md");
    expect(fs.existsSync(path.join(root, ".agentbridge", "project_inspect_packet.md"))).toBe(true);
  });

  it("supports project registry CLI commands", () => {
    const registryRoot = makeTempRoot("agentbridge-cli-registry-");
    const projectRoot = makeTempRoot("agentbridge-cli-registered-");

    const current = JSON.parse(runCli(registryRoot, "project", "register-current", "RegistryRoot"));
    expect(current.id).toBe("RegistryRoot");

    const registered = JSON.parse(runCli(registryRoot, "project", "register", "OtherProject", projectRoot));
    expect(registered.id).toBe("OtherProject");
    expect(registered.root).toBe(path.resolve(projectRoot));

    const list = runCli(registryRoot, "project", "list");
    expect(list).toContain("RegistryRoot");
    expect(list).toContain("OtherProject");
    expect(list).toContain("Git");
    expect(list).toContain("Status");
    expect(list).toContain("Last seen");

    const inspect = JSON.parse(runCli(registryRoot, "project", "inspect", "OtherProject", "--json"));
    expect(inspect.ok).toBe(true);
    expect(inspect.project.id).toBe("OtherProject");

    const removed = JSON.parse(runCli(registryRoot, "project", "remove", "OtherProject"));
    expect(removed.removed).toBe(true);
    const listJson = JSON.parse(runCli(registryRoot, "project", "list", "--json"));
    expect(listJson.projects.map((project: { id: string }) => project.id)).toEqual(["RegistryRoot"]);
  });

  it("supports project registry current-project fallback in CLI", () => {
    const root = makeTempRoot("agentbridge-cli-fallback-");
    const fallbackId = path.basename(root);

    const list = runCli(root, "project", "list");
    expect(list).toContain("Current-project fallback is active");
    expect(list).toContain(fallbackId);

    const inspect = JSON.parse(runCli(root, "project", "inspect", fallbackId, "--json"));
    expect(inspect.ok).toBe(true);
    expect(inspect.project.id).toBe(fallbackId);
    expect(inspect.project.registered).toBe(false);
  });

  it("supports safe project discovery preview and JSON output", () => {
    const registryRoot = makeTempRoot("agentbridge-cli-scan-preview-registry-");
    const scanRoot = makeTempRoot("agentbridge-cli-scan-preview-");
    fs.mkdirSync(path.join(scanRoot, "ProjectA"), { recursive: true });
    fs.writeFileSync(path.join(scanRoot, "ProjectA", "package.json"), "{\"name\":\"project-a\"}\n", "utf8");
    fs.mkdirSync(path.join(scanRoot, "ProjectB"), { recursive: true });
    fs.writeFileSync(path.join(scanRoot, "ProjectB", "pyproject.toml"), "[project]\n", "utf8");
    fs.mkdirSync(path.join(scanRoot, "node_modules", "FakeProject"), { recursive: true });
    fs.writeFileSync(path.join(scanRoot, "node_modules", "FakeProject", "package.json"), "{}", "utf8");

    const preview = runCli(registryRoot, "project", "scan", scanRoot, "--preview");

    expect(preview).toContain("Found 2 candidate projects");
    expect(preview).toContain("[1] ProjectA");
    expect(preview).toContain("[2] ProjectB");
    expect(preview).not.toContain("FakeProject");
    expect(fs.existsSync(path.join(registryRoot, ".agentbridge", "projects.json"))).toBe(false);

    const json = JSON.parse(runCli(registryRoot, "project", "scan", scanRoot, "--preview", "--json"));
    expect(json.ok).toBe(true);
    expect(json.mode).toBe("preview");
    expect(json.candidates.map((candidate: { id: string }) => candidate.id)).toEqual(["ProjectA", "ProjectB"]);
    expect(json.registered).toEqual([]);
  });

  it("supports safe project discovery register, select, list, and inspect", () => {
    const registryRoot = makeTempRoot("agentbridge-cli-scan-register-registry-");
    const scanRoot = makeTempRoot("agentbridge-cli-scan-register-");
    fs.mkdirSync(path.join(scanRoot, "ProjectA"), { recursive: true });
    fs.writeFileSync(path.join(scanRoot, "ProjectA", "package.json"), "{\"name\":\"project-a\"}\n", "utf8");
    fs.mkdirSync(path.join(scanRoot, "ProjectB"), { recursive: true });
    fs.writeFileSync(path.join(scanRoot, "ProjectB", "pyproject.toml"), "[project]\n", "utf8");

    const selected = runCli(registryRoot, "project", "scan", scanRoot, "--register", "--select", "1");
    expect(selected).toContain("Registered 1 project");
    let listJson = JSON.parse(runCli(registryRoot, "project", "list", "--json"));
    expect(listJson.projects.map((project: { id: string }) => project.id)).toEqual(["ProjectA"]);
    expect(listJson.projects[0].source).toBe("scan");

    const inspect = JSON.parse(runCli(registryRoot, "project", "inspect", "ProjectA", "--json"));
    expect(inspect.ok).toBe(true);
    expect(inspect.project.id).toBe("ProjectA");

    const all = runCli(registryRoot, "project", "scan", scanRoot, "--register");
    expect(all).toContain("Registered 2 project");
    listJson = JSON.parse(runCli(registryRoot, "project", "list", "--json"));
    expect(listJson.projects.map((project: { id: string }) => project.id)).toEqual(["ProjectA", "ProjectB"]);

    const invalid = runCliFailure(registryRoot, "project", "scan", scanRoot, "--register", "--select", "9");
    expect(invalid).toContain("Invalid --select index");
  });

  it("supports project tree, find-file, read-file, grep, and active project CLI commands", () => {
    const registryRoot = makeTempRoot("agentbridge-cli-file-registry-");
    const projectRoot = makeTempRoot("agentbridge-cli-file-project-");
    const suffix = randomUUID().replace(/-/g, "");
    const token = `CODEXLINK_GAMMA_TOKEN_${randomUUID()}`;
    const relativePath = `docs_${suffix.slice(0, 8)}\\note_${suffix}.txt`;
    fs.mkdirSync(path.dirname(path.join(projectRoot, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, relativePath), `${token}\nCLI generated file.\n`, "utf8");
    fs.writeFileSync(path.join(projectRoot, "safe-secret.txt"), `Authorization: Bearer ${"a".repeat(32)}\n`, "utf8");

    JSON.parse(runCli(registryRoot, "project", "register", "CliGamma", projectRoot));

    const tree = JSON.parse(runCli(registryRoot, "project", "tree", "CliGamma", "--json"));
    expect(tree.entries.some((entry: { path: string }) => entry.path === relativePath.replace(/\\/g, "/"))).toBe(true);

    const find = JSON.parse(runCli(registryRoot, "project", "find-file", "CliGamma", `note_${suffix}`, "--json"));
    expect(find.matches.map((match: { path: string }) => match.path)).toEqual([relativePath.replace(/\\/g, "/")]);

    const read = JSON.parse(runCli(registryRoot, "project", "read-file", "CliGamma", relativePath, "--json"));
    expect(read.content).toContain(token);

    const grep = JSON.parse(runCli(registryRoot, "project", "grep", "CliGamma", token, "--json"));
    expect(grep.matches.map((match: { path: string }) => match.path)).toEqual([relativePath.replace(/\\/g, "/")]);

    const redacted = JSON.parse(runCli(registryRoot, "project", "read-file", "CliGamma", "safe-secret.txt", "--json"));
    expect(redacted.content).toContain("Bearer [REDACTED]");

    const evidence = JSON.parse(runCli(registryRoot, "session", "evidence", "CliGamma", "--json"));
    expect(evidence.evidence.map((item: { kind: string }) => item.kind)).toEqual(
      expect.arrayContaining(["tree_seen", "file_search", "file_read", "grep_seen"])
    );
    const grepEvidence = evidence.evidence.find((item: { kind: string }) => item.kind === "grep_seen");
    expect(grepEvidence.metadata.query).toBe("[REDACTED]");
    expect(grepEvidence.metadata).not.toHaveProperty("content");
    expect(grepEvidence.metadata).not.toHaveProperty("snippet");
    const cliSummary = JSON.parse(runCli(registryRoot, "session", "summary", "CliGamma", "--json"));
    expect(cliSummary.summary.recent_evidence.length).toBeGreaterThanOrEqual(4);
    const sessionEvidenceFile = path.join(
      registryRoot,
      ".agentbridge",
      "sessions",
      "CliGamma",
      cliSummary.summary.session_id,
      "evidence.jsonl"
    );
    const evidenceText = fs.readFileSync(sessionEvidenceFile, "utf8");
    expect(evidenceText).not.toContain(token);
    expect(evidenceText).not.toContain("CLI generated file.");
    expect(evidenceText).not.toContain("Authorization: Bearer");

    const selected = JSON.parse(runCli(registryRoot, "project", "select", "CliGamma"));
    expect(selected.active_project.id).toBe("CliGamma");
    const eventFile = path.join(registryRoot, ".agentbridge", "active_project_events.jsonl");
    const events = fs.readFileSync(eventFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "select_project",
      project_id: "CliGamma",
      previous_project_id: null,
      selected_by: "cli"
    });
    expect(events[0].root_hint).toContain(path.basename(projectRoot));
    const eventText = fs.readFileSync(eventFile, "utf8");
    expect(eventText).not.toContain(token);
    expect(eventText).not.toContain("Authorization");
    expect(eventText).not.toContain("Bearer");
    expect(eventText).not.toContain("OPENAI_API_KEY");
    expect(eventText).not.toContain("sk-");
    expect(eventText).not.toContain(projectRoot);
    const active = JSON.parse(runCli(registryRoot, "project", "active"));
    expect(active.active_project.id).toBe("CliGamma");
    const cleared = JSON.parse(runCli(registryRoot, "project", "clear-active"));
    expect(cleared.cleared).toBe(true);
  });

  it("supports shared session CLI commands without leaking secrets", () => {
    const registryRoot = makeTempRoot("agentbridge-cli-session-registry-");
    const token = `sk-${"a".repeat(32)}`;

    JSON.parse(runCli(registryRoot, "project", "register-current", "AgentBridge"));

    const active = JSON.parse(runCli(registryRoot, "session", "active", "--json"));
    expect(active.ok).toBe(true);
    expect(active.summary.revision).toBe(1);

    const bootstrapped = JSON.parse(runCli(registryRoot, "session", "bootstrap", "AgentBridge", "--source", "codex_plugin", "--json"));
    expect(bootstrapped.ok).toBe(true);
    expect(bootstrapped.project_id).toBe("AgentBridge");
    expect(bootstrapped.bootstrap_event_created).toBe(true);
    expect(bootstrapped.revision).toBe(2);
    expect(bootstrapped.recommended_next_action).toBe("set_goal_or_ask_user");
    expect(bootstrapped.active_clients[0]).toMatchObject({
      client: "codex",
      adapter: "cli",
      source: "codex_plugin",
      last_tool: "session_bootstrap"
    });

    const heartbeat = JSON.parse(runCli(registryRoot, "session", "bootstrap", "AgentBridge", "--source", "codex_plugin", "--json"));
    expect(heartbeat.ok).toBe(true);
    expect(heartbeat.bootstrap_event_created).toBe(false);
    expect(heartbeat.revision).toBe(bootstrapped.revision);

    const summary = JSON.parse(runCli(registryRoot, "session", "summary", "AgentBridge", "--json"));
    expect(summary.summary.project_id).toBe("AgentBridge");
    expect(summary.summary.active_clients).toHaveLength(1);

    const event = JSON.parse(
      runCli(
        registryRoot,
        "session",
        "event",
        "AgentBridge",
        "--actor",
        "codex",
        "--type",
        "note",
        "--summary",
        `Started with OPENAI_API_KEY=${token}`,
        "--details",
        `Authorization: Bearer ${"b".repeat(32)}`,
        "--expected-revision",
        String(bootstrapped.revision),
        "--json"
      )
    );
    expect(event.event.summary).toContain("[REDACTED]");
    expect(JSON.stringify(event)).not.toContain(token);

    const handoff = JSON.parse(
      runCli(
        registryRoot,
        "session",
        "handoff",
        "AgentBridge",
        "--from",
        "chatgpt",
        "--to",
        "codex",
        "--title",
        "Implement session CLI",
        "--message",
        `Do not leak token=${token}`,
        "--constraints",
        "No release,No tag change",
        "--expected-output",
        "files changed,tests run",
        "--json"
      )
    );
    expect(handoff.handoff.status).toBe("open");
    expect(JSON.stringify(handoff)).not.toContain(token);

    const openHandoffs = JSON.parse(runCli(registryRoot, "session", "handoffs", "AgentBridge", "--open", "--json"));
    expect(openHandoffs.handoffs).toHaveLength(1);

    const updated = JSON.parse(
      runCli(
        registryRoot,
        "session",
        "update-handoff",
        "AgentBridge",
        handoff.handoff.id,
        "--status",
        "acknowledged",
        "--summary",
        `Acknowledged PASSWORD=${token}`,
        "--json"
      )
    );
    expect(updated.handoff.status).toBe("acknowledged");
    expect(updated.handoff.result_summary).toContain("[REDACTED]");

    const goal = JSON.parse(
      runCli(
        registryRoot,
        "session",
        "set-goal",
        "AgentBridge",
        "Build shared workspace memory.",
        "--phase",
        "implementation",
        "--status",
        "in_progress",
        "--json"
      )
    );
    expect(goal.summary.current_goal).toBe("Build shared workspace memory.");
    expect(goal.summary.phase).toBe("implementation");

    const check = JSON.parse(
      runCli(
        registryRoot,
        "session",
        "check",
        "AgentBridge",
        "--type",
        "test",
        "--status",
        "pass",
        "--summary",
        `npm test passed with token=${token}`,
        "--command",
        `npm test --token=${token}`,
        "--exit-code",
        "0",
        "--duration-ms",
        "42",
        "--json"
      )
    );
    expect(check.check.summary).toContain("[REDACTED]");
    expect(check.check.command).toContain("[REDACTED]");
    expect(JSON.stringify(check)).not.toContain(token);
    const checks = JSON.parse(runCli(registryRoot, "session", "checks", "AgentBridge", "--json"));
    expect(checks.checks.at(-1)).toMatchObject({ type: "test", status: "pass", exit_code: 0, duration_ms: 42 });

    const activity = JSON.parse(
      runCli(
        registryRoot,
        "session",
        "activity-add",
        "AgentBridge",
        "--kind",
        "file_create",
        "--status",
        "success",
        "--summary",
        `Created file with OPENAI_API_KEY=${token}`,
        "--path",
        "notes/activity.txt",
        "--metadata",
        JSON.stringify({ content: `raw content ${token}`, stdout: "long output should not store", bytes: 12 }),
        "--json"
      )
    );
    expect(activity.activity.id).toMatch(/^act_\d{6}$/);
    expect(activity.activity.summary).toContain("[REDACTED]");
    expect(activity.activity.metadata).not.toHaveProperty("content");
    expect(activity.activity.metadata).not.toHaveProperty("stdout");
    const recentActivity = JSON.parse(runCli(registryRoot, "session", "activity", "AgentBridge", "--json"));
    expect(recentActivity.activities.at(-1)).toMatchObject({ kind: "file_create", status: "success" });
    expect(recentActivity.activities.some((item: { kind: string }) => item.kind === "handoff_added")).toBe(true);
    expect(recentActivity.activities.some((item: { kind: string }) => item.kind === "handoff_acknowledged")).toBe(true);
    expect(recentActivity.activities.some((item: { kind: string }) => item.kind === "check_logged")).toBe(true);
    expect(JSON.stringify(recentActivity)).not.toContain(token);

    const fileTimeline = JSON.parse(runCli(registryRoot, "session", "timeline", "AgentBridge", "--file", "notes/activity.txt", "--json"));
    expect(fileTimeline.activities.some((item: { kind: string }) => item.kind === "file_create")).toBe(true);
    const handoffTimeline = JSON.parse(runCli(registryRoot, "session", "timeline", "AgentBridge", "--handoff", handoff.handoff.id, "--json"));
    expect(handoffTimeline.activities.some((item: { kind: string }) => item.kind === "handoff_added")).toBe(true);
    expect(handoffTimeline.activities.some((item: { kind: string }) => item.kind === "handoff_acknowledged")).toBe(true);
    const taskActivity = JSON.parse(
      runCli(
        registryRoot,
        "session",
        "activity-add",
        "AgentBridge",
        "--kind",
        "task_complete",
        "--status",
        "success",
        "--summary",
        "CLI task complete marker",
        "--task-id",
        "cli-task-1",
        "--json"
      )
    );
    expect(taskActivity.activity.kind).toBe("task_complete");
    const taskTimeline = JSON.parse(runCli(registryRoot, "session", "timeline", "AgentBridge", "--task", "cli-task-1", "--json"));
    expect(taskTimeline.activities.at(-1)).toMatchObject({ kind: "task_complete", task_id: "cli-task-1" });
    const context = JSON.parse(runCli(registryRoot, "session", "context", "AgentBridge", "--compact", "--json"));
    expect(context.recent_activity.length).toBeGreaterThan(0);
    expect(context.workspace).toHaveProperty("recent_gaps");

    const updates = JSON.parse(runCli(registryRoot, "session", "updates", "AgentBridge", "--since", "1", "--json"));
    expect(updates.events.length).toBeGreaterThan(0);
    expect(updates.checks.some((item: { type: string; status: string }) => item.type === "test" && item.status === "pass")).toBe(true);
    expect(updates.activity.some((item: { kind: string; status: string }) => item.kind === "file_create" && item.status === "success")).toBe(true);

    const sessionDir = path.join(registryRoot, ".agentbridge", "sessions", "AgentBridge");
    expect(fs.existsSync(path.join(sessionDir, "active_session.json"))).toBe(true);
    const stored = [
      fs.readFileSync(path.join(sessionDir, active.session.session_id, "events.jsonl"), "utf8"),
      fs.readFileSync(path.join(sessionDir, active.session.session_id, "checks.jsonl"), "utf8"),
      fs.readFileSync(path.join(sessionDir, active.session.session_id, "activity.jsonl"), "utf8")
    ].join("\n");
    expect(stored).not.toContain(token);
    expect(stored).not.toContain("Authorization: Bearer b");
    expect(stored).not.toContain("long output should not store");
  }, 15000);

  it("supports workspace reconcile and file verification CLI metadata", () => {
    const registryRoot = makeTempRoot("agentbridge-cli-workspace-");
    run(registryRoot, "git", ["init"]);
    fs.writeFileSync(path.join(registryRoot, ".gitignore"), ".agentbridge/\n", "utf8");
    JSON.parse(runCli(registryRoot, "project", "register-current", "AgentBridge"));

    fs.writeFileSync(path.join(registryRoot, "workspace-gap.txt"), "safe metadata gap\n", "utf8");
    const reconcile = JSON.parse(runCli(registryRoot, "session", "reconcile", "AgentBridge", "--json"));
    expect(reconcile.activities_written.some((activity: { kind: string }) => activity.kind === "workspace_snapshot")).toBe(true);
    expect(
      reconcile.activities_written.some((activity: { kind: string; paths: string[] }) => activity.kind === "activity_gap_detected" && activity.paths.includes("workspace-gap.txt"))
    ).toBe(true);

    const hash = createHash("sha256").update(fs.readFileSync(path.join(registryRoot, "workspace-gap.txt"))).digest("hex");
    const verified = JSON.parse(runCli(registryRoot, "session", "file-verify", "AgentBridge", "--path", "workspace-gap.txt", "--expect-sha256", hash, "--json"));
    expect(verified.verified).toBe(true);
    expect(verified.activity).toMatchObject({
      kind: "file_verify",
      metadata: {
        content_stored: false,
        sha256: hash
      }
    });

    fs.writeFileSync(path.join(registryRoot, ".env"), "TOKEN=should_not_read\n", "utf8");
    expect(() => runCli(registryRoot, "session", "file-verify", "AgentBridge", "--path", ".env", "--json")).toThrow();

    const summary = JSON.parse(runCli(registryRoot, "session", "summary", "AgentBridge", "--json"));
    const sessionDir = path.join(registryRoot, ".agentbridge", "sessions", "AgentBridge", summary.summary.session_id);
    const activityText = fs.readFileSync(path.join(sessionDir, "activity.jsonl"), "utf8");
    expect(activityText).not.toContain("safe metadata gap");
    expect(activityText).not.toContain("TOKEN=should_not_read");
    expect(activityText).not.toContain("diff --git");
  }, 15000);

  it("supports CodexLink setup dry-run and doctor JSON without printing secrets", () => {
    const setup = JSON.parse(runCli(process.cwd(), "setup", "codex-plugin", "--dry-run", "--json"));
    expect(setup.ok).toBe(true);
    expect(setup.dry_run).toBe(true);
    expect(setup.checks.some((item: { name: string; status: string }) => item.name === "plugin_json" && item.status === "PASS")).toBe(true);
    const setupText = JSON.stringify(setup);
    expect(setupText).not.toContain(".agentbridge/local_token");
    expect(setupText).not.toContain("Bearer ");
    expect(setupText).not.toContain("OPENAI_API_KEY");
    expect(setupText).not.toContain("sk-");

    const doctorOutput = runCli(process.cwd(), "doctor", "--project", "AgentBridge", "--json");
    const doctor = JSON.parse(doctorOutput);
    expect(doctor.checks.some((item: { name: string; status: string }) => item.name === "hook_dry_run" && item.status === "PASS")).toBe(true);
    expect(doctor.checks.some((item: { name: string; status: string }) => item.name === "runtime_git_status" && item.status === "PASS")).toBe(true);
    expect(doctorOutput).not.toContain(".agentbridge/local_token");
    expect(doctorOutput).not.toContain("local_token");
    expect(doctorOutput).not.toContain("Bearer ");
    expect(doctorOutput).not.toContain("OPENAI_API_KEY");
    expect(doctorOutput).not.toContain("sk-");
  });

  it("uses setup gpt-actions host and port in dry-run next steps", () => {
    const setup = JSON.parse(
      runCli(process.cwd(), "setup", "gpt-actions", "--dry-run", "--host", "127.0.0.2", "--port", "7788", "--json")
    );
    expect(setup.ok).toBe(true);
    expect(setup.next_steps).toContain("Start AgentBridge local server at http://127.0.0.2:7788.");
  });

  it("supports one-click launcher setup dry-run without writing runtime config", () => {
    const registryRoot = makeTempRoot("agentbridge-cli-launcher-");
    const configPath = path.join(registryRoot, ".agentbridge", "launcher-config.json");
    const setup = JSON.parse(
      runCli(
        registryRoot,
        "setup",
        "launcher",
        "--dry-run",
        "--project",
        "AgentBridge",
        "--public-url",
        "https://codexlink.example.com",
        "--gpt-url",
        "https://chatgpt.com/g/example",
        "--json"
      )
    );
    expect(setup.ok).toBe(true);
    expect(setup.dry_run).toBe(true);
    expect(setup.changed_files).toEqual([]);
    expect(fs.existsSync(configPath)).toBe(false);
    expect(JSON.stringify(setup)).not.toContain("local_token");
    expect(JSON.stringify(setup)).not.toContain("Bearer ");
    expect(JSON.stringify(setup)).not.toContain("OPENAI_API_KEY");
  });

  it("supports relay setup dry-run as a non-production placeholder", () => {
    const registryRoot = makeTempRoot("agentbridge-cli-relay-");
    const relayConfigPath = path.join(registryRoot, ".agentbridge", "relay-config.json");
    const setup = JSON.parse(runCli(registryRoot, "setup", "relay", "--dry-run", "--json"));
    expect(setup.ok).toBe(true);
    expect(setup.dry_run).toBe(true);
    expect(setup.changed_files).toEqual([]);
    expect(setup.checks.some((item: { name: string; status: string }) => item.name === "relay_mode" && item.status === "WARN")).toBe(true);
    expect(fs.existsSync(relayConfigPath)).toBe(false);
    expect(JSON.stringify(setup)).not.toContain("local_token");
    expect(JSON.stringify(setup)).not.toContain("Bearer ");
    expect(JSON.stringify(setup)).not.toContain("OPENAI_API_KEY");
  });

  it("prints relay protocol spec without enabling production relay", () => {
    const registryRoot = makeTempRoot("agentbridge-cli-relay-spec-");
    const output = runCli(registryRoot, "relay", "spec", "--json");
    const result = JSON.parse(output);
    expect(result.ok).toBe(true);
    expect(result.spec.status).toBe("spec_only");
    expect(result.spec.pairing.required).toBe(true);
    expect(result.spec.allowed_routes.some((route: { operation_id: string }) => route.operation_id === "getSessionSummary")).toBe(true);
    expect(output).not.toContain("/mcp");
    expect(output).not.toContain("local_token");
    expect(output).not.toContain("OPENAI_API_KEY");
  });

  it("keeps active project event logs local-only", () => {
    const ignored = run(process.cwd(), "git", ["check-ignore", "-v", ".agentbridge/active_project_events.jsonl"]);
    expect(ignored).toContain(".agentbridge/");
  });
});
