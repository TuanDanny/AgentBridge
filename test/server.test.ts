import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLocalToken } from "../src/auth.js";
import { captureProject } from "../src/core.js";
import { requestJson } from "../src/httpJson.js";
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

    const allowed = await requestJson({
      host: running.info.host,
      port: running.info.port,
      path: "/session",
      token: readLocalToken(root)
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ ok: true });
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

    const dashboardResponse = await fetch(`http://${running.info.host}:${running.info.port}/dashboard`);
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
