import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLocalToken } from "../src/auth.js";
import { captureProject } from "../src/core.js";
import { requestJson } from "../src/httpJson.js";
import { registerProject } from "../src/registry.js";
import { createApproval } from "../src/safety.js";
import { startAgentBridgeServer, type RunningAgentBridgeServer } from "../src/server.js";

const tempRoots: string[] = [];
const runningServers: RunningAgentBridgeServer[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-server-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const running of runningServers.splice(0)) {
    await running.close().catch(() => undefined);
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("local daemon", () => {
  it("serves health publicly and protects session data with the local token", async () => {
    const root = makeTempRoot();
    const running = await startAgentBridgeServer(root, { port: 0 });
    runningServers.push(running);

    const health = await requestJson({
      host: running.info.host,
      port: running.info.port,
      path: "/health"
    });
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ ok: true, name: "agentbridge" });

    const denied = await requestJson({
      host: running.info.host,
      port: running.info.port,
      path: "/session"
    });
    expect(denied.status).toBe(401);

    for (const path of ["/dashboard", "/chatgpt/session-summary", "/chatgpt/repo-status", "/chatgpt/context"]) {
      const protectedResponse = await requestJson({
        host: running.info.host,
        port: running.info.port,
        path
      });
      expect(protectedResponse.status).toBe(401);
    }

    const allowed = await requestJson({
      host: running.info.host,
      port: running.info.port,
      path: "/session",
      token: readLocalToken(root)
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ ok: true });
  });

  it("serves project inspector endpoints for the current project when no registry exists", async () => {
    const root = makeTempRoot();
    captureProject(root, "short");
    fs.writeFileSync(path.join(root, ".agentbridge", "codex_progress.md"), "Progress with API_TOKEN=abc123.", "utf8");
    fs.writeFileSync(path.join(root, ".agentbridge", "codex_result.md"), "Result with PASSWORD=hunter2.", "utf8");
    fs.writeFileSync(path.join(root, ".agentbridge", "chatgpt_review.md"), "Review with SECRET=private.", "utf8");
    const running = await startAgentBridgeServer(root, { port: 0 });
    runningServers.push(running);
    const token = readLocalToken(root);

    const denied = await requestJson({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects"
    });
    expect(denied.status).toBe(401);

    const projects = await requestJson<{
      ok: boolean;
      mode: string;
      projects: Array<{ id: string; name: string; registered: boolean; git_available: boolean }>;
    }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects",
      token
    });
    expect(projects.status).toBe(200);
    expect(projects.body.ok).toBe(true);
    expect(projects.body.mode).toBe("current_project_fallback");
    expect(projects.body.projects).toHaveLength(1);
    expect(projects.body.projects[0].name).toBe(path.basename(root));
    expect(projects.body.projects[0].registered).toBe(false);
    expect(typeof projects.body.projects[0].git_available).toBe("boolean");

    const projectId = encodeURIComponent(projects.body.projects[0].id);
    for (const route of ["inspect", "codex-changes", "review-packet"]) {
      const protectedResponse = await requestJson({
        host: running.info.host,
        port: running.info.port,
        path: `/chatgpt/projects/${projectId}/${route}`
      });
      expect(protectedResponse.status).toBe(401);
    }

    const inspect = await requestJson<{
      ok: boolean;
      project: { id: string };
      repo: { branch: string };
      codex: { progress_summary: string };
      agentbridge: { next_action: string };
    }>({
      host: running.info.host,
      port: running.info.port,
      path: `/chatgpt/projects/${projectId}/inspect`,
      token
    });
    expect(inspect.status).toBe(200);
    expect(inspect.body.project.id).toBe(projects.body.projects[0].id);
    expect(inspect.body.repo.branch).toBeDefined();
    expect(inspect.body.agentbridge.next_action).toBe("create_codex_prompt");
    expect(inspect.body.codex.progress_summary).toContain("[REDACTED]");
    expect(inspect.body.codex.progress_summary).not.toContain("abc123");

    const changes = await requestJson<{ ok: boolean; codex_progress: string; codex_result: string; changed_files: unknown[] }>({
      host: running.info.host,
      port: running.info.port,
      path: `/chatgpt/projects/${projectId}/codex-changes`,
      token
    });
    expect(changes.status).toBe(200);
    expect(changes.body.ok).toBe(true);
    expect(changes.body.codex_progress).toContain("[REDACTED]");
    expect(changes.body.codex_result).toContain("[REDACTED]");
    expect(changes.body.codex_result).not.toContain("hunter2");
    expect(Array.isArray(changes.body.changed_files)).toBe(true);

    const review = await requestJson<{ ok: boolean; review_packet: { summary: string; files_changed: unknown[] } }>({
      host: running.info.host,
      port: running.info.port,
      path: `/chatgpt/projects/${projectId}/review-packet`,
      token
    });
    expect(review.status).toBe(200);
    expect(review.body.ok).toBe(true);
    expect(review.body.review_packet.summary).toContain("[REDACTED]");
    expect(review.body.review_packet.summary).not.toContain("private");
    expect(Array.isArray(review.body.review_packet.files_changed)).toBe(true);
  });

  it("returns a safe 404 for unknown project inspector ids", async () => {
    const root = makeTempRoot();
    const running = await startAgentBridgeServer(root, { port: 0 });
    runningServers.push(running);

    const unknown = await requestJson<{ ok: boolean; error: { code: string; message: string } }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects/not-registered/inspect",
      token: readLocalToken(root)
    });

    expect(unknown.status).toBe(404);
    expect(unknown.body.ok).toBe(false);
    expect(unknown.body.error.code).toBe("project_not_found");
    expect(unknown.body.error.message).toContain("agentbridge project register");
  });

  it("rejects raw filesystem path project ids through HTTP", async () => {
    const root = makeTempRoot();
    registerProject(root, "SafeProject", root);
    const running = await startAgentBridgeServer(root, { port: 0 });
    runningServers.push(running);

    const rawPathId = encodeURIComponent(path.resolve(root));
    const response = await requestJson<{ ok: boolean; error: { code: string } }>({
      host: running.info.host,
      port: running.info.port,
      path: `/chatgpt/projects/${rawPathId}/inspect`,
      token: readLocalToken(root)
    });

    expect(response.status).toBe(404);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe("project_not_found");
  });

  it("does not expose an HTTP MCP route", async () => {
    const root = makeTempRoot();
    const running = await startAgentBridgeServer(root, { port: 0 });
    runningServers.push(running);

    const response = await requestJson({
      host: running.info.host,
      port: running.info.port,
      path: "/mcp",
      token: readLocalToken(root)
    });

    expect(response.status).toBe(404);
  });

  it("routes project inspector requests through the registry when projects are registered", async () => {
    const serverRoot = makeTempRoot();
    const registeredRoot = makeTempRoot();
    captureProject(registeredRoot, "short");
    fs.mkdirSync(path.join(serverRoot, ".agentbridge"), { recursive: true });
    fs.writeFileSync(path.join(serverRoot, ".agentbridge", "codex_result.md"), "Wrong server result.", "utf8");
    fs.writeFileSync(path.join(registeredRoot, ".agentbridge", "codex_result.md"), "Registered result.", "utf8");
    fs.writeFileSync(path.join(registeredRoot, ".agentbridge", "chatgpt_review.md"), "Registered review.", "utf8");
    registerProject(serverRoot, "RegisteredProject", registeredRoot);
    const running = await startAgentBridgeServer(serverRoot, { port: 0 });
    runningServers.push(running);
    const token = readLocalToken(serverRoot);

    const projects = await requestJson<{
      ok: boolean;
      mode: string;
      projects: Array<{ id: string; name: string; registered: boolean; root_hint: string; git_available: boolean }>;
    }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects",
      token
    });
    expect(projects.status).toBe(200);
    expect(projects.body.mode).toBe("registry");
    expect(projects.body.projects).toHaveLength(1);
    expect(projects.body.projects[0].id).toBe("RegisteredProject");
    expect(projects.body.projects[0].name).toBe(path.basename(registeredRoot));
    expect(projects.body.projects[0].registered).toBe(true);
    expect(typeof projects.body.projects[0].git_available).toBe("boolean");
    expect(projects.body.projects[0].root_hint).toContain(path.basename(registeredRoot));
    expect(projects.body.projects[0].root_hint).not.toBe(path.resolve(registeredRoot));

    const inspect = await requestJson<{ ok: boolean; project: { name: string; registered: boolean }; codex: { result_summary: string } }>({
      host: running.info.host,
      port: running.info.port,
      path: `/chatgpt/projects/${encodeURIComponent(projects.body.projects[0].id)}/inspect`,
      token
    });
    expect(inspect.status).toBe(200);
    expect(inspect.body.project.name).toBe(path.basename(registeredRoot));
    expect(inspect.body.project.registered).toBe(true);
    expect(inspect.body.codex.result_summary).toContain("Registered result.");
    expect(inspect.body.codex.result_summary).not.toContain("Wrong server result.");

    const changes = await requestJson<{ ok: boolean; codex_result: string }>({
      host: running.info.host,
      port: running.info.port,
      path: `/chatgpt/projects/${encodeURIComponent(projects.body.projects[0].id)}/codex-changes`,
      token
    });
    expect(changes.status).toBe(200);
    expect(changes.body.codex_result).toContain("Registered result.");

    const review = await requestJson<{ ok: boolean; review_packet: { summary: string } }>({
      host: running.info.host,
      port: running.info.port,
      path: `/chatgpt/projects/${encodeURIComponent(projects.body.projects[0].id)}/review-packet`,
      token
    });
    expect(review.status).toBe(200);
    expect(review.body.review_packet.summary).toContain("Registered review.");
  });

  it("redacts project review packets and marks force-push approvals non-actionable", async () => {
    const serverRoot = makeTempRoot();
    const projectRoot = makeTempRoot();
    captureProject(projectRoot, "short");
    const projectLocalToken = "project-local-token-1234567890";
    fs.writeFileSync(path.join(projectRoot, ".agentbridge", "local_token"), projectLocalToken, "utf8");
    const reviewPath = path.join(projectRoot, ".agentbridge", "chatgpt_review.md");
    fs.writeFileSync(
      reviewPath,
      [
        "# Review",
        "",
        `Root: ${projectRoot}`,
        "## Commands Run",
        "",
        "- Not run yet.",
        "",
        "## Tests",
        "",
        "Not run yet.",
        "",
        `local_token=${projectLocalToken}`,
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        "OPENAI_API_KEY=sk-123456789012345678901234",
        "-----BEGIN PRIVATE KEY-----",
        "private-body",
        "-----END PRIVATE KEY-----"
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(path.join(projectRoot, ".agentbridge", "codex_result.md"), "Result after review.", "utf8");
    const oldDate = new Date(Date.now() - 10_000);
    fs.utimesSync(reviewPath, oldDate, oldDate);
    createApproval(projectRoot, {
      action: "run_command",
      command: "git push --force",
      reason: "Rejected by stale safety review.",
      risk: "high"
    });
    registerProject(serverRoot, "ReviewProject", projectRoot);
    const running = await startAgentBridgeServer(serverRoot, { port: 0 });
    runningServers.push(running);
    const token = readLocalToken(serverRoot);

    const inspect = await requestJson<{ ok: boolean; project: { root_hint: string }; codex: { review_packet_summary: string; review_packet_stale: boolean }; safety: { pending_approvals: number; approvals: Array<{ actionable: boolean; stale: boolean; recommendation: string }> } }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects/ReviewProject/inspect",
      token
    });
    expect(inspect.status).toBe(200);
    expect(inspect.body.project.root_hint).toContain(path.basename(projectRoot));
    expect(inspect.body.project.root_hint).not.toBe(path.resolve(projectRoot));
    expect(inspect.body.codex.review_packet_stale).toBe(true);
    expect(inspect.body.safety.pending_approvals).toBe(0);
    expect(inspect.body.safety.approvals[0]).toMatchObject({
      actionable: false,
      stale: true,
      recommendation: "Do not run this command."
    });

    const review = await requestJson<{ ok: boolean; review_packet: { root_hint: string; summary: string; stale: boolean; stale_reason?: string; tests: { stale: boolean; latest_summary: string }; approvals: Array<{ actionable: boolean; stale: boolean; recommendation: string }> } }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects/ReviewProject/review-packet",
      token
    });
    const serialized = JSON.stringify({ inspect: inspect.body, review: review.body });
    expect(review.status).toBe(200);
    expect(review.body.review_packet.root_hint).toContain(path.basename(projectRoot));
    expect(review.body.review_packet.root_hint).not.toBe(path.resolve(projectRoot));
    expect(review.body.review_packet.stale).toBe(true);
    expect(review.body.review_packet.stale_reason).toBe("review packet older than current repo/session/test data");
    expect(review.body.review_packet.summary).toContain("No fresh command log was found.");
    expect(review.body.review_packet.summary).toContain("No fresh test log was found.");
    expect(review.body.review_packet.tests.latest_summary).toBe("No fresh test log was found.");
    expect(review.body.review_packet.tests.stale).toBe(true);
    expect(review.body.review_packet.approvals[0]).toMatchObject({
      actionable: false,
      stale: true,
      recommendation: "Do not run this command."
    });
    expect(serialized).not.toContain(path.resolve(projectRoot));
    expect(serialized).not.toContain(projectLocalToken);
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(serialized).not.toContain("sk-123456789012345678901234");
    expect(serialized).not.toContain("private-body");
    expect(serialized).not.toContain("- Not run yet.");
  });

  it("returns multiple explicitly registered projects", async () => {
    const serverRoot = makeTempRoot();
    const parentA = makeTempRoot();
    const parentB = makeTempRoot();
    const projectA = path.join(parentA, "same-project");
    const projectB = path.join(parentB, "same-project");
    fs.mkdirSync(projectA);
    fs.mkdirSync(projectB);
    captureProject(projectA, "short");
    captureProject(projectB, "short");
    registerProject(serverRoot, "ProjectA", projectA);
    registerProject(serverRoot, "ProjectB", projectB);
    const running = await startAgentBridgeServer(serverRoot, { port: 0 });
    runningServers.push(running);

    const projects = await requestJson<{ mode: string; projects: Array<{ id: string; name: string; registered: boolean }> }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects",
      token: readLocalToken(serverRoot)
    });

    expect(projects.status).toBe(200);
    expect(projects.body.mode).toBe("registry");
    expect(projects.body.projects).toHaveLength(2);
    expect(projects.body.projects.every((project) => project.name === "same-project")).toBe(true);
    expect(projects.body.projects.map((project) => project.id)).toEqual(["ProjectA", "ProjectB"]);
    expect(projects.body.projects.every((project) => project.registered)).toBe(true);

    for (const project of projects.body.projects) {
      const inspect = await requestJson<{ ok: boolean; project: { id: string; name: string } }>({
        host: running.info.host,
        port: running.info.port,
        path: `/chatgpt/projects/${encodeURIComponent(project.id)}/inspect`,
        token: readLocalToken(serverRoot)
      });
      expect(inspect.status).toBe(200);
      expect(inspect.body.project.id).toBe(project.id);
    }
  });

  it("serves ChatGPT bridge read endpoints with token and redacts context", async () => {
    const root = makeTempRoot();
    captureProject(root, "short");
    fs.appendFileSync(path.join(root, ".agentbridge", "project_context.md"), "\nOPENAI_API_KEY=sk-testsecret1234567890\n");
    const running = await startAgentBridgeServer(root, { port: 0 });
    runningServers.push(running);
    const token = readLocalToken(root);

    const session = await requestJson<{ ok: boolean; session: { project_name: string } }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/session-summary",
      token
    });
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ ok: true });
    expect(session.body.session.project_name).toBe(path.basename(root));

    const repo = await requestJson<{ ok: boolean; available: boolean; branch: string; changed_files: string[] }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/repo-status",
      token
    });
    expect(repo.status).toBe(200);
    expect(repo.body.ok).toBe(true);
    expect(typeof repo.body.available).toBe("boolean");
    expect(Array.isArray(repo.body.changed_files)).toBe(true);

    const context = await requestJson<{ ok: boolean; context: string }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/context",
      token
    });
    expect(context.status).toBe(200);
    expect(context.body.context).toContain("# Project Context");
    expect(context.body.context).toContain("[REDACTED]");
    expect(context.body.context).not.toContain("sk-testsecret");

    const task = await requestJson<{ ok: boolean; task: string }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/next-task",
      token
    });
    expect(task.status).toBe(200);
    expect(task.body.task).toContain("No Codex prompt found");

    const review = await requestJson<{ ok: boolean; review: string }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/review-packet",
      token
    });
    expect(review.status).toBe(200);
    expect(review.body.review).toContain("No ChatGPT review packet");
  });

  it("returns a useful ChatGPT context fallback when context has not been captured", async () => {
    const root = makeTempRoot();
    const running = await startAgentBridgeServer(root, { port: 0 });
    runningServers.push(running);

    const context = await requestJson<{ ok: boolean; error: string }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/context",
      token: readLocalToken(root)
    });

    expect(context.status).toBe(404);
    expect(context.body.error).toContain("Run agentbridge capture");
  });

  it("creates prompts and records progress/results through ChatGPT bridge endpoints", async () => {
    const root = makeTempRoot();
    captureProject(root, "short");
    const running = await startAgentBridgeServer(root, { port: 0 });
    runningServers.push(running);
    const token = readLocalToken(root);

    const prompt = await requestJson<{ ok: boolean; prompt: string; session: { user_goal: string } }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/create-codex-prompt",
      method: "POST",
      token,
      body: {
        plan: "# ChatGPT Plan\n\nUse MY_TOKEN=secret-value while planning.",
        user_goal: "Bridge task"
      }
    });
    expect(prompt.status).toBe(200);
    expect(prompt.body.prompt).toContain("# Task for Codex");
    expect(prompt.body.prompt).toContain("[REDACTED]");
    expect(prompt.body.session.user_goal).toBe("Bridge task");
    expect(fs.readFileSync(path.join(root, ".agentbridge", "chatgpt_plan.md"), "utf8")).not.toContain("secret-value");

    const task = await requestJson<{ ok: boolean; task: string }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/next-task",
      token
    });
    expect(task.body.task).toContain("Bridge task");

    const progress = await requestJson<{ ok: boolean; session: { status: string } }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/report-progress",
      method: "POST",
      token,
      body: { progress: "Working with API_TOKEN=abc123." }
    });
    expect(progress.status).toBe(200);
    expect(progress.body.session.status).toBe("codex_working");
    const progressFile = fs.readFileSync(path.join(root, ".agentbridge", "codex_progress.md"), "utf8");
    expect(progressFile).toContain("[REDACTED]");
    expect(progressFile).not.toContain("abc123");

    const result = await requestJson<{ ok: boolean; session: { status: string } }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/submit-codex-result",
      method: "POST",
      token,
      body: { result: "# Codex Result\n\nDone with PASSWORD=hunter2." }
    });
    expect(result.status).toBe(200);
    expect(result.body.session.status).toBe("result_ready");
    const resultFile = fs.readFileSync(path.join(root, ".agentbridge", "codex_result.md"), "utf8");
    expect(resultFile).toContain("[REDACTED]");
    expect(resultFile).not.toContain("hunter2");
  });

  it("classifies risky ChatGPT commands and creates approval requests", async () => {
    const root = makeTempRoot();
    const running = await startAgentBridgeServer(root, { port: 0 });
    runningServers.push(running);
    const token = readLocalToken(root);

    const classified = await requestJson<{
      ok: boolean;
      risk: string;
      requiresApproval: boolean;
      blocked: boolean;
      reasons: string[];
    }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/classify-command",
      method: "POST",
      token,
      body: { command: "rm -rf node_modules" }
    });
    expect(classified.status).toBe(200);
    expect(classified.body.risk).toBe("high");
    expect(classified.body.requiresApproval).toBe(true);
    expect(classified.body.blocked).toBe(true);
    expect(classified.body.reasons).toContain("Recursive force delete.");

    const approval = await requestJson<{ ok: boolean; approval: { actor: string; status: string; risk: string } }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/request-approval",
      method: "POST",
      token,
      body: {
        action: "run_command",
        command: "git push --force",
        reason: "Need explicit user approval.",
        risk: "high"
      }
    });
    expect(approval.status).toBe(200);
    expect(approval.body.approval.actor).toBe("chatgpt");
    expect(approval.body.approval.status).toBe("pending");
    expect(approval.body.approval.risk).toBe("high");
  });

  it("returns captured context and accepts ChatGPT plan and Codex result updates", async () => {
    const root = makeTempRoot();
    captureProject(root, "short");
    const running = await startAgentBridgeServer(root, { port: 0 });
    runningServers.push(running);
    const token = readLocalToken(root);

    const context = await requestJson<{ ok: boolean; context: string }>({
      host: running.info.host,
      port: running.info.port,
      path: "/context",
      token
    });
    expect(context.status).toBe(200);
    expect(context.body.context).toContain("# Project Context");

    const plan = await requestJson({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/plan",
      method: "POST",
      token,
      body: { plan: "# ChatGPT Plan\n\nDo the focused task.", user_goal: "Focused task" }
    });
    expect(plan.status).toBe(200);

    const result = await requestJson({
      host: running.info.host,
      port: running.info.port,
      path: "/codex/result",
      method: "POST",
      token,
      body: { result: "# Codex Result\n\nDone." }
    });
    expect(result.status).toBe(200);

    const session = JSON.parse(fs.readFileSync(path.join(root, ".agentbridge", "session.json"), "utf8"));
    expect(session.user_goal).toBe("Focused task");
    expect(session.status).toBe("result_ready");
    expect(fs.readFileSync(path.join(root, ".agentbridge", "codex_result.md"), "utf8")).toContain("Done.");
  });

  it("creates and resolves approvals over token-protected HTTP endpoints", async () => {
    const root = makeTempRoot();
    const running = await startAgentBridgeServer(root, { port: 0 });
    runningServers.push(running);
    const token = readLocalToken(root);

    const request = await requestJson<{ ok: boolean; approval: { id: string; status: string; risk: string } }>({
      host: running.info.host,
      port: running.info.port,
      path: "/approval/request",
      method: "POST",
      token,
      body: { action: "run_command", command: "git push --force" }
    });
    expect(request.status).toBe(200);
    expect(request.body.approval.status).toBe("pending");
    expect(request.body.approval.risk).toBe("high");

    const list = await requestJson<{ ok: boolean; approvals: Array<{ id: string }> }>({
      host: running.info.host,
      port: running.info.port,
      path: "/approvals?status=pending",
      token
    });
    expect(list.body.approvals).toHaveLength(1);

    const approve = await requestJson({
      host: running.info.host,
      port: running.info.port,
      path: "/approve",
      method: "POST",
      token,
      body: { id: request.body.approval.id }
    });
    expect(approve.status).toBe(200);
  });

  it("serves dashboard HTML and supports dashboard action endpoints", async () => {
    const root = makeTempRoot();
    const running = await startAgentBridgeServer(root, { port: 0 });
    runningServers.push(running);
    const token = readLocalToken(root);

    const dashboardResponse = await fetch(`http://${running.info.host}:${running.info.port}/dashboard`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(dashboardResponse.status).toBe(200);
    expect(await dashboardResponse.text()).toContain("AgentBridge Dashboard");

    const prompt = await requestJson({
      host: running.info.host,
      port: running.info.port,
      path: "/codex/prompt",
      method: "POST",
      token,
      body: {}
    });
    expect(prompt.status).toBe(200);

    const review = await requestJson({
      host: running.info.host,
      port: running.info.port,
      path: "/review",
      method: "POST",
      token,
      body: {}
    });
    expect(review.status).toBe(200);

    const task = await requestJson<{ ok: boolean; task: string }>({
      host: running.info.host,
      port: running.info.port,
      path: "/codex/task",
      token
    });
    expect(task.body.task).toContain("# Task for Codex");
  });

  it("exposes the local multi-project registry endpoint", async () => {
    const root = makeTempRoot();
    const registeredRoot = makeTempRoot();
    registerProject(root, "RegistryEndpoint", registeredRoot);
    const running = await startAgentBridgeServer(root, { port: 0 });
    runningServers.push(running);

    const projects = await requestJson<{ ok: boolean; registry: { version: number; projects: unknown[] } }>({
      host: running.info.host,
      port: running.info.port,
      path: "/projects",
      token: readLocalToken(root)
    });

    expect(projects.status).toBe(200);
    expect(projects.body.ok).toBe(true);
    expect(projects.body.registry.version).toBe(1);
    expect(Array.isArray(projects.body.registry.projects)).toBe(true);
    expect(projects.body.registry.projects).toHaveLength(1);
  });

  it("serves shared session GPT Action endpoints with auth, redaction, and safe project routing", async () => {
    const serverRoot = makeTempRoot();
    const projectRoot = makeTempRoot();
    registerProject(serverRoot, "SessionProject", projectRoot);
    const running = await startAgentBridgeServer(serverRoot, { port: 0 });
    runningServers.push(running);
    const token = readLocalToken(serverRoot);
    const secret = `sk-${"a".repeat(32)}`;

    const denied = await requestJson({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects/SessionProject/session/summary"
    });
    expect(denied.status).toBe(401);

    const session = await requestJson<{ ok: boolean; summary: { revision: number; project_id: string } }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects/SessionProject/session/summary",
      token
    });
    expect(session.status).toBe(200);
    expect(session.body.ok).toBe(true);
    expect(session.body.summary.project_id).toBe("SessionProject");
    expect(session.body.summary.revision).toBe(1);

    const event = await requestJson<{ ok: boolean; event: { summary: string; details: string; redacted: boolean }; revision: number }>(
      {
        host: running.info.host,
        port: running.info.port,
        path: "/chatgpt/projects/SessionProject/session/events",
        method: "POST",
        token,
        body: {
          actor: "chatgpt",
          type: "decision",
          summary: `Use shared session with OPENAI_API_KEY=${secret}`,
          details: `Authorization: Bearer ${"b".repeat(32)}`
        }
      }
    );
    expect(event.status).toBe(200);
    expect(event.body.revision).toBe(2);
    expect(event.body.event.redacted).toBe(true);
    expect(JSON.stringify(event.body)).not.toContain(secret);
    expect(JSON.stringify(event.body)).not.toContain("OPENAI_API_KEY=");

    const invalidActor = await requestJson({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects/SessionProject/session/events",
      method: "POST",
      token,
      body: { actor: "bad", type: "note", summary: "Invalid actor" }
    });
    expect(invalidActor.status).toBe(400);

    const handoff = await requestJson<{ ok: boolean; handoff: { id: string; status: string; message: string }; revision: number }>(
      {
        host: running.info.host,
        port: running.info.port,
        path: "/chatgpt/projects/SessionProject/session/handoffs",
        method: "POST",
        token,
        body: {
          from: "chatgpt",
          to: "codex",
          title: "Implement beta endpoints",
          message: `Do not leak token=${secret}`,
          constraints: ["No release", "No /mcp"],
          expected_output: ["tests run"]
        }
      }
    );
    expect(handoff.status).toBe(200);
    expect(handoff.body.handoff.status).toBe("open");
    expect(JSON.stringify(handoff.body)).not.toContain(secret);
    expect(JSON.stringify(handoff.body)).not.toContain("token=");

    const updated = await requestJson<{ ok: boolean; handoff: { status: string; result_summary: string }; revision: number }>(
      {
        host: running.info.host,
        port: running.info.port,
        path: `/chatgpt/projects/SessionProject/session/handoffs/${handoff.body.handoff.id}`,
        method: "POST",
        token,
        body: { actor: "codex", status: "acknowledged", result_summary: `Acknowledged PASSWORD=${secret}` }
      }
    );
    expect(updated.status).toBe(200);
    expect(updated.body.handoff.status).toBe("acknowledged");
    expect(updated.body.handoff.result_summary).toContain("[REDACTED]");

    const goal = await requestJson<{ ok: boolean; summary: { current_goal: string; phase: string; current_status: string } }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects/SessionProject/session/goal",
      method: "POST",
      token,
      body: { actor: "chatgpt", goal: "Coordinate v0.6 shared session.", phase: "implementation", status: "in_progress" }
    });
    expect(goal.status).toBe(200);
    expect(goal.body.summary.current_goal).toBe("Coordinate v0.6 shared session.");
    expect(goal.body.summary.phase).toBe("implementation");
    expect(goal.body.summary.current_status).toBe("in_progress");

    const updates = await requestJson<{ events: unknown[]; handoffs: unknown[]; to_revision: number }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects/SessionProject/session/updates?since_revision=1",
      token
    });
    expect(updates.status).toBe(200);
    expect(updates.body.to_revision).toBeGreaterThan(1);
    expect(updates.body.events.length).toBeGreaterThan(0);
    expect(updates.body.handoffs.length).toBeGreaterThan(0);

    const projectSession = await requestJson<{ ok: boolean; state: { revision: number }; summary: { revision: number; session_id: string } }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects/SessionProject/session",
      token
    });
    expect(projectSession.status).toBe(200);
    expect(projectSession.body.state.revision).toBe(projectSession.body.summary.revision);

    const unknown = await requestJson({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects/MissingProject/session/summary",
      token
    });
    expect(unknown.status).toBe(404);

    const rawProject = await requestJson({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects/D:%5CAgentBridge/session/summary",
      token
    });
    expect(rawProject.status).toBe(404);

    const stored = fs.readFileSync(
      path.join(serverRoot, ".agentbridge", "sessions", "SessionProject", projectSession.body.summary.session_id, "events.jsonl"),
      "utf8"
    );
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain("OPENAI_API_KEY=");
  });

  it("serves randomized safe project file browser and active project endpoints", async () => {
    const serverRoot = makeTempRoot();
    const projectRoot = makeTempRoot();
    const suffix = randomUUID().replace(/-/g, "");
    const token = `CODEXLINK_GAMMA_TOKEN_${randomUUID()}`;
    const folder = `folder_${suffix.slice(0, 8)}`;
    const noteFile = `${folder}/note_${suffix}.txt`;
    const targetFile = `nested_${suffix.slice(8, 16)}/level1/target_${suffix}.txt`;
    const largeFile = `large_${suffix}.txt`;
    const largeContent = `Authorization: Bearer ${"b".repeat(32)}\n${"L".repeat(512 * 1024 + 4096)}`;
    fs.mkdirSync(path.join(projectRoot, folder), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, path.dirname(targetFile)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, noteFile), `${token}\nGenerated file.\n`, "utf8");
    fs.writeFileSync(path.join(projectRoot, targetFile), `Nested ${token}\n`, "utf8");
    fs.writeFileSync(path.join(projectRoot, largeFile), largeContent, "utf8");
    fs.writeFileSync(path.join(projectRoot, "safe-secret.txt"), `Authorization: Bearer ${"a".repeat(32)}\n`, "utf8");
    fs.writeFileSync(path.join(projectRoot, ".env"), `OPENAI_API_KEY=sk-${"a".repeat(24)}\n`, "utf8");
    fs.mkdirSync(path.join(projectRoot, ".agentbridge"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".agentbridge", "local_token"), "local-token-value\n", "utf8");
    fs.writeFileSync(path.join(projectRoot, "secret.pem"), "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n", "utf8");
    fs.mkdirSync(path.join(projectRoot, "node_modules", "fake"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "node_modules", "fake", `note_${suffix}.txt`), token, "utf8");
    fs.mkdirSync(path.join(projectRoot, ".git", "objects"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".git", "objects", `target_${suffix}.txt`), token, "utf8");
    fs.mkdirSync(path.join(projectRoot, "dist", "generated"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "dist", "generated", `target_${suffix}.txt`), token, "utf8");
    fs.mkdirSync(path.join(projectRoot, "build", "generated"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "build", "generated", `note_${suffix}.txt`), token, "utf8");
    fs.writeFileSync(path.join(projectRoot, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    registerProject(serverRoot, "GammaProject", projectRoot);

    const running = await startAgentBridgeServer(serverRoot, { port: 0 });
    runningServers.push(running);
    const localToken = readLocalToken(serverRoot);

    const denied = await requestJson({ host: running.info.host, port: running.info.port, path: "/chatgpt/projects/GammaProject/tree" });
    expect(denied.status).toBe(401);

    const defaultTree = await requestJson<{
      max_depth: number;
      max_entries: number;
      inventory: { max_depth_used: number; max_entries_used: number };
    }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects/GammaProject/tree",
      token: localToken
    });
    expect(defaultTree.status).toBe(200);
    expect(defaultTree.body.max_depth).toBe(6);
    expect(defaultTree.body.max_entries).toBe(6000);
    expect(defaultTree.body.inventory.max_depth_used).toBe(6);
    expect(defaultTree.body.inventory.max_entries_used).toBe(6000);

    const overCapTree = await requestJson<{ ok: boolean; error: { code: string; message: string } }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects/GammaProject/tree?max_entries=10001",
      token: localToken
    });
    expect(overCapTree.status).toBe(400);
    expect(overCapTree.body.ok).toBe(false);
    expect(overCapTree.body.error.message).toContain("10000");

    const tree = await requestJson<{
      ok: boolean;
      entries: Array<{ path: string }>;
      root_hint: string;
      max_entries: number;
      total_files: number;
      total_folders: number;
      inventory: { complete: boolean; scale_hint: string; tree_truncated: boolean };
      classification: { generated_dirs: string[]; vendor_dirs: string[]; tooling_dirs: string[] };
      important_candidates: Array<{ path: string; reason: string; priority: string }>;
      recommended_next_reads: Array<{ path: string; why: string }>;
      coverage_warning: { level: string; message: string } | null;
      recommended_next_action: string | null;
    }>(
      {
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects/GammaProject/tree?max_depth=4",
      token: localToken
      }
    );
    expect(tree.status).toBe(200);
    expect(tree.body.max_entries).toBe(6000);
    expect(tree.body.entries.map((entry) => entry.path)).toContain(noteFile);
    expect(tree.body.entries.map((entry) => entry.path)).toContain(targetFile);
    expect(tree.body.total_files).toBeGreaterThanOrEqual(4);
    expect(tree.body.total_folders).toBeGreaterThanOrEqual(2);
    expect(tree.body.entries.some((entry) => entry.path.includes("node_modules"))).toBe(false);
    expect(tree.body.entries.some((entry) => entry.path.includes(".git"))).toBe(false);
    expect(tree.body.entries.some((entry) => entry.path.includes("dist"))).toBe(false);
    expect(tree.body.entries.some((entry) => entry.path.includes("build"))).toBe(false);
    expect(tree.body.root_hint).toContain(path.basename(projectRoot));
    expect(tree.body.root_hint).not.toBe(projectRoot);
    expect(tree.body.inventory.scale_hint).toBe("small");
    expect(tree.body.inventory.complete).toBe(true);
    expect(tree.body.inventory.tree_truncated).toBe(false);
    expect(tree.body.classification.generated_dirs).toEqual(expect.arrayContaining(["build", "dist"]));
    expect(tree.body.classification.vendor_dirs).toContain("node_modules");
    expect(tree.body.classification.tooling_dirs).toContain(".git");
    expect(Array.isArray(tree.body.important_candidates)).toBe(true);
    expect(Array.isArray(tree.body.recommended_next_reads)).toBe(true);
    expect(tree.body.coverage_warning).toBeNull();
    expect(tree.body.recommended_next_action === null || tree.body.recommended_next_action.includes("Read")).toBe(true);

    const shallowTree = await requestJson<{ entries: Array<{ path: string }> }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects/GammaProject/tree?max_depth=1",
      token: localToken
    });
    expect(shallowTree.status).toBe(200);
    expect(shallowTree.body.entries.map((entry) => entry.path)).not.toContain(targetFile);

    const tinyTree = await requestJson<{ returned_entries: number; truncated: boolean; inventory: { complete: boolean; tree_truncated: boolean }; coverage_warning: { level: string; message: string } | null }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects/GammaProject/tree?max_depth=4&max_entries=1",
      token: localToken
    });
    expect(tinyTree.status).toBe(200);
    expect(tinyTree.body.returned_entries).toBe(1);
    expect(tinyTree.body.truncated).toBe(true);
    expect(tinyTree.body.inventory.complete).toBe(false);
    expect(tinyTree.body.inventory.tree_truncated).toBe(true);
    expect(tinyTree.body.coverage_warning?.level).toBe("partial");

    const search = await requestJson<{ matches: Array<{ path: string }> }>({
      host: running.info.host,
      port: running.info.port,
      path: `/chatgpt/projects/GammaProject/files/search?q=${encodeURIComponent(`note_${suffix}`)}`,
      token: localToken
    });
    expect(search.status).toBe(200);
    expect(search.body.matches.map((match) => match.path)).toEqual([noteFile]);

    const nestedSearch = await requestJson<{ matches: Array<{ path: string }> }>({
      host: running.info.host,
      port: running.info.port,
      path: `/chatgpt/projects/GammaProject/files/search?q=${encodeURIComponent(`target_${suffix}.txt`)}`,
      token: localToken
    });
    expect(nestedSearch.status).toBe(200);
    expect(nestedSearch.body.matches.map((match) => match.path)).toEqual([targetFile]);

    const read = await requestJson<{ content: string; path: string; redacted: boolean; read_status: string; line_count: number; bytes_returned: number; coverage_warning: string | null }>({
      host: running.info.host,
      port: running.info.port,
      path: `/chatgpt/projects/GammaProject/file?path=${encodeURIComponent(noteFile)}`,
      token: localToken
    });
    expect(read.status).toBe(200);
    expect(read.body.path).toBe(noteFile);
    expect(read.body.content).toContain(token);
    expect(read.body.redacted).toBe(false);
    expect(read.body.read_status).toBe("complete");
    expect(read.body.line_count).toBeGreaterThan(0);
    expect(read.body.bytes_returned).toBe(Buffer.byteLength(read.body.content));
    expect(read.body.coverage_warning).toBeNull();

    const grep = await requestJson<{ matches: Array<{ path: string; snippet: string }> }>({
      host: running.info.host,
      port: running.info.port,
      path: `/chatgpt/projects/GammaProject/grep?q=${encodeURIComponent(token)}`,
      token: localToken
    });
    expect(grep.status).toBe(200);
    expect(grep.body.matches.map((match) => match.path).sort()).toEqual([noteFile, targetFile].sort());
    expect(grep.body.matches.some((match) => match.path.includes("node_modules"))).toBe(false);

    const limitedGrep = await requestJson<{ matches: Array<{ path: string }> }>({
      host: running.info.host,
      port: running.info.port,
      path: `/chatgpt/projects/GammaProject/grep?q=${encodeURIComponent(token)}&max_matches=1`,
      token: localToken
    });
    expect(limitedGrep.status).toBe(200);
    expect(limitedGrep.body.matches).toHaveLength(1);

    const redactedRead = await requestJson<{ content: string; redacted: boolean }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects/GammaProject/file?path=safe-secret.txt",
      token: localToken
    });
    expect(redactedRead.status).toBe(200);
    expect(redactedRead.body.content).toContain("Bearer [REDACTED]");
    expect(redactedRead.body.redacted).toBe(true);

    const largeRead = await requestJson<{ ok: boolean; content: string; truncated: boolean; redacted: boolean; size: number; read_status: string; line_count_estimate: number; coverage_warning: string | null }>({
      host: running.info.host,
      port: running.info.port,
      path: `/chatgpt/projects/GammaProject/file?path=${encodeURIComponent(largeFile)}`,
      token: localToken
    });
    expect(largeRead.status).toBe(200);
    expect(largeRead.body.ok).toBe(true);
    expect(largeRead.body.truncated).toBe(true);
    expect(largeRead.body.read_status).toBe("partial");
    expect(largeRead.body.line_count_estimate).toBeGreaterThan(0);
    expect(largeRead.body.coverage_warning).toContain("Only part");
    expect(largeRead.body.size).toBe(Buffer.byteLength(largeContent));
    expect(largeRead.body.content.length).toBeGreaterThan(0);
    expect(largeRead.body.content.length).toBeLessThan(largeContent.length);
    expect(largeRead.body.content).toContain("Bearer [REDACTED]");
    expect(largeRead.body.content).not.toContain("b".repeat(32));
    expect(largeRead.body.redacted).toBe(true);

    for (const unsafePath of [
      "..%5Csecret.txt",
      "..%2Fsecret.txt",
      encodeURIComponent(projectRoot),
      "C:%5CWindows%5Cwin.ini",
      ".env",
      ".agentbridge%2Flocal_token",
      "secret.pem",
      "binary.bin"
    ]) {
      const blocked = await requestJson<{ ok: boolean; read_status: string; coverage_warning: string; blocked_reason?: string; error: { code: string } }>({
        host: running.info.host,
        port: running.info.port,
        path: `/chatgpt/projects/GammaProject/file?path=${unsafePath}`,
        token: localToken
      });
      expect(blocked.status).toBe(400);
      expect(["blocked", "binary", "error"]).toContain(blocked.body.read_status);
      expect(blocked.body.coverage_warning).toContain("not read");
    }

    const missingFile = await requestJson<{ ok: boolean; read_status: string; coverage_warning: string; error: { code: string } }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects/GammaProject/file?path=missing-file.txt",
      token: localToken
    });
    expect(missingFile.status).toBe(404);
    expect(missingFile.body.read_status).toBe("not_found");
    expect(missingFile.body.coverage_warning).toContain("not found");

    const unknown = await requestJson({ host: running.info.host, port: running.info.port, path: "/chatgpt/projects/MissingProject/tree", token: localToken });
    expect(unknown.status).toBe(404);
    const rawProject = await requestJson({ host: running.info.host, port: running.info.port, path: "/chatgpt/projects/D:%5CAgentBridge/tree", token: localToken });
    expect(rawProject.status).toBe(404);
    for (const scanPath of ["/chatgpt/scan", "/chatgpt/projects/scan"]) {
      const response = await requestJson({ host: running.info.host, port: running.info.port, path: scanPath, token: localToken });
      expect(response.status).toBe(404);
    }

    const activeDenied = await requestJson({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/active-project"
    });
    expect(activeDenied.status).toBe(401);

    const selectDenied = await requestJson({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects/GammaProject/select",
      method: "POST",
      body: {}
    });
    expect(selectDenied.status).toBe(401);

    const select = await requestJson<{ ok: boolean; active_project: { id: string; root_hint: string } }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects/GammaProject/select",
      method: "POST",
      token: localToken,
      body: {}
    });
    expect(select.status).toBe(200);
    expect(select.body.active_project.id).toBe("GammaProject");

    const eventFile = path.join(serverRoot, ".agentbridge", "active_project_events.jsonl");
    const eventsAfterSelect = fs.readFileSync(eventFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(eventsAfterSelect).toHaveLength(1);
    expect(eventsAfterSelect[0]).toMatchObject({
      event: "select_project",
      project_id: "GammaProject",
      previous_project_id: null,
      selected_by: "chatgpt_action"
    });
    expect(eventsAfterSelect[0].root_hint).toContain(path.basename(projectRoot));

    const active = await requestJson<{ active_project: { id: string } }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/active-project",
      token: localToken
    });
    expect(active.status).toBe(200);
    expect(active.body.active_project.id).toBe("GammaProject");
    expect(fs.readFileSync(eventFile, "utf8").trim().split(/\r?\n/)).toHaveLength(1);

    const selectAgain = await requestJson({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects/GammaProject/select",
      method: "POST",
      token: localToken,
      body: {}
    });
    expect(selectAgain.status).toBe(200);
    const eventsAfterRepeat = fs.readFileSync(eventFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(eventsAfterRepeat).toHaveLength(2);
    expect(eventsAfterRepeat[1].previous_project_id).toBe("GammaProject");

    const unknownSelect = await requestJson({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects/MissingProject/select",
      method: "POST",
      token: localToken,
      body: {}
    });
    expect(unknownSelect.status).toBe(404);
    const invalidSelect = await requestJson({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects/D:%5CAgentBridge/select",
      method: "POST",
      token: localToken,
      body: {}
    });
    expect(invalidSelect.status).toBe(404);
    expect(fs.readFileSync(eventFile, "utf8").trim().split(/\r?\n/)).toHaveLength(2);

    const activeFile = fs.readFileSync(path.join(serverRoot, ".agentbridge", "active_project.json"), "utf8");
    expect(activeFile).not.toContain(localToken);
    expect(activeFile).not.toContain("Bearer");
    expect(activeFile).not.toContain(projectRoot);
    const eventText = fs.readFileSync(eventFile, "utf8");
    expect(eventText).not.toContain(localToken);
    expect(eventText).not.toContain("Authorization");
    expect(eventText).not.toContain("Bearer");
    expect(eventText).not.toContain("OPENAI_API_KEY");
    expect(eventText).not.toContain("sk-");
    expect(eventText).not.toContain(projectRoot);
  });
});
