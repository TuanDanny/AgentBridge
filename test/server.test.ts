import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLocalToken } from "../src/auth.js";
import { captureProject } from "../src/core.js";
import { requestJson } from "../src/httpJson.js";
import { addProject } from "../src/registry.js";
import { startAgentBridgeServer, type RunningAgentBridgeServer } from "../src/server.js";

const tempRoots: string[] = [];
const runningServers: RunningAgentBridgeServer[] = [];
const originalHome = process.env.AGENTBRIDGE_HOME;

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-server-"));
  tempRoots.push(root);
  return root;
}

function restoreAgentBridgeHome(): void {
  if (originalHome === undefined) {
    delete process.env.AGENTBRIDGE_HOME;
    return;
  }

  process.env.AGENTBRIDGE_HOME = originalHome;
}

afterEach(async () => {
  restoreAgentBridgeHome();
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
    const registryHome = makeTempRoot();
    process.env.AGENTBRIDGE_HOME = registryHome;
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

    const projects = await requestJson<{ ok: boolean; projects: Array<{ id: string; name: string; registered: boolean }> }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects",
      token
    });
    expect(projects.status).toBe(200);
    expect(projects.body.ok).toBe(true);
    expect(projects.body.projects).toHaveLength(1);
    expect(projects.body.projects[0].name).toBe(path.basename(root));
    expect(projects.body.projects[0].registered).toBe(false);

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
    const registryHome = makeTempRoot();
    process.env.AGENTBRIDGE_HOME = registryHome;
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
    expect(unknown.body.error.message).toContain("agentbridge projects add");
  });

  it("routes project inspector requests through the registry when projects are registered", async () => {
    const registryHome = makeTempRoot();
    process.env.AGENTBRIDGE_HOME = registryHome;
    const serverRoot = makeTempRoot();
    const registeredRoot = makeTempRoot();
    captureProject(registeredRoot, "short");
    fs.writeFileSync(path.join(registeredRoot, ".agentbridge", "codex_result.md"), "Registered result.", "utf8");
    addProject(registeredRoot);
    const running = await startAgentBridgeServer(serverRoot, { port: 0 });
    runningServers.push(running);
    const token = readLocalToken(serverRoot);

    const projects = await requestJson<{ ok: boolean; projects: Array<{ id: string; name: string; registered: boolean }> }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects",
      token
    });
    expect(projects.status).toBe(200);
    expect(projects.body.projects).toHaveLength(1);
    expect(projects.body.projects[0].name).toBe(path.basename(registeredRoot));
    expect(projects.body.projects[0].registered).toBe(true);

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
  });

  it("uses distinct safe ids for registered projects with the same name", async () => {
    const registryHome = makeTempRoot();
    process.env.AGENTBRIDGE_HOME = registryHome;
    const serverRoot = makeTempRoot();
    const parentA = makeTempRoot();
    const parentB = makeTempRoot();
    const projectA = path.join(parentA, "same-project");
    const projectB = path.join(parentB, "same-project");
    fs.mkdirSync(projectA);
    fs.mkdirSync(projectB);
    captureProject(projectA, "short");
    captureProject(projectB, "short");
    addProject(projectA);
    addProject(projectB);
    const running = await startAgentBridgeServer(serverRoot, { port: 0 });
    runningServers.push(running);

    const projects = await requestJson<{ projects: Array<{ id: string; name: string }> }>({
      host: running.info.host,
      port: running.info.port,
      path: "/chatgpt/projects",
      token: readLocalToken(serverRoot)
    });

    expect(projects.status).toBe(200);
    expect(projects.body.projects).toHaveLength(2);
    expect(projects.body.projects.every((project) => project.name === "same-project")).toBe(true);
    expect(new Set(projects.body.projects.map((project) => project.id)).size).toBe(2);
    expect(projects.body.projects.some((project) => project.id.includes(projectA))).toBe(false);
    expect(projects.body.projects.some((project) => project.id.includes(projectB))).toBe(false);
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
    expect(review.body.review).toContain("No ChatGPT review packet found");
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

  it("exposes the multi-project registry endpoint", async () => {
    const root = makeTempRoot();
    const running = await startAgentBridgeServer(root, { port: 0 });
    runningServers.push(running);

    const projects = await requestJson<{ ok: boolean; projects: unknown[] }>({
      host: running.info.host,
      port: running.info.port,
      path: "/projects",
      token: readLocalToken(root)
    });

    expect(projects.status).toBe(200);
    expect(projects.body.ok).toBe(true);
    expect(Array.isArray(projects.body.projects)).toBe(true);
  });
});
