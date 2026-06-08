import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentBridgeMcpServer } from "../src/mcpServer.js";
import {
  addSessionHandoff,
  appendSessionActivity,
  appendSessionEvent,
  getSessionSummary,
  listSessionHandoffs,
  updateSessionHandoff
} from "../src/sessionStore.js";

const tempRoots: string[] = [];
const clients: Client[] = [];
const servers: Awaited<ReturnType<typeof createConnectedClient>>[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-mcp-"));
  tempRoots.push(root);
  return root;
}

async function createConnectedClient(root: string) {
  const server = createAgentBridgeMcpServer(root);
  const client = new Client({ name: "agentbridge-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  return { server, client };
}

function firstText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  if (!("content" in result)) {
    return "";
  }

  const first = result.content[0];
  return first && first.type === "text" ? first.text : "";
}

function firstJson<T = Record<string, unknown>>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  return JSON.parse(firstText(result)) as T;
}

async function expectToolFailure(callback: () => Promise<Awaited<ReturnType<Client["callTool"]>>>): Promise<void> {
  try {
    const result = await callback();
    expect(result.isError).toBe(true);
  } catch (error) {
    expect(error).toBeDefined();
  }
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close().catch(() => undefined);
  }
  for (const item of servers.splice(0)) {
    await item.server.close().catch(() => undefined);
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("MCP server", () => {
  it("lists AgentBridge tools and creates a Codex prompt from a plan", async () => {
    const root = makeTempRoot();
    const connected = await createConnectedClient(root);
    servers.push(connected);

    const tools = await connected.client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "get_project_context",
        "get_session_summary",
        "create_codex_prompt",
        "get_next_task",
        "report_progress",
        "submit_codex_result",
        "review_codex_result"
      ])
    );

    const prompt = await connected.client.callTool({
      name: "create_codex_prompt",
      arguments: {
        plan: "# ChatGPT Plan\n\n1. Make a focused change.",
        user_goal: "Focused MCP task"
      }
    });
    expect(firstText(prompt)).toContain("# Task for Codex");

    const nextTask = await connected.client.callTool({
      name: "get_next_task",
      arguments: {}
    });
    expect(firstText(nextTask)).toContain("Focused MCP task");
  });

  it("records progress, submits result, and creates a review packet", async () => {
    const root = makeTempRoot();
    const connected = await createConnectedClient(root);
    servers.push(connected);

    await connected.client.callTool({
      name: "report_progress",
      arguments: { progress: "Working on the focused task." }
    });
    await connected.client.callTool({
      name: "submit_codex_result",
      arguments: { result: "# Codex Result\n\nImplemented." }
    });
    const review = await connected.client.callTool({
      name: "review_codex_result",
      arguments: {}
    });

    expect(firstText(review)).toContain("# ChatGPT Review Packet");
    expect(fs.readFileSync(path.join(root, ".agentbridge", "codex_progress.md"), "utf8")).toContain(
      "Working on the focused task."
    );
    expect(fs.readFileSync(path.join(root, ".agentbridge", "codex_result.md"), "utf8")).toContain("Implemented.");
  });

  it("classifies risky commands and creates approval requests", async () => {
    const root = makeTempRoot();
    const connected = await createConnectedClient(root);
    servers.push(connected);

    const classified = await connected.client.callTool({
      name: "classify_command",
      arguments: { command: "git push --force" }
    });
    expect(firstText(classified)).toContain("\"risk\": \"high\"");

    const approval = await connected.client.callTool({
      name: "request_user_approval",
      arguments: { action: "run_command", command: "git push --force" }
    });
    expect(firstText(approval)).toContain("\"status\": \"pending\"");
    expect(fs.readFileSync(path.join(root, ".agentbridge", "approvals.json"), "utf8")).toContain("git push --force");
  });

  it("exposes shared session MCP tools", async () => {
    const root = makeTempRoot();
    const connected = await createConnectedClient(root);
    servers.push(connected);

    const tools = await connected.client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "session_active",
        "session_bootstrap",
        "session_summary",
        "session_updates",
        "session_activity",
        "session_list_handoffs",
        "session_append_event",
        "session_add_handoff",
        "session_update_handoff",
        "session_set_goal",
        "session_append_check"
      ])
    );
  });

  it("bootstraps shared sessions through MCP without duplicate start events", async () => {
    const root = makeTempRoot();
    const projectId = "AgentBridge";
    const connected = await createConnectedClient(root);
    servers.push(connected);

    const first = firstJson<{
      project_id: string;
      session_id: string;
      revision: number;
      bootstrap_event_created: boolean;
      recommended_next_action: string;
      active_clients: Array<{ client: string; adapter: string; source: string; last_tool: string }>;
      recent_events: Array<{ summary: string }>;
    }>(
      await connected.client.callTool({
        name: "session_bootstrap",
        arguments: { project_id: projectId, source: "codex_plugin" }
      })
    );
    expect(first.project_id).toBe(projectId);
    expect(first.bootstrap_event_created).toBe(true);
    expect(first.revision).toBe(2);
    expect(first.recommended_next_action).toBe("set_goal_or_ask_user");
    expect(first.active_clients[0]).toMatchObject({
      client: "codex",
      adapter: "mcp",
      source: "codex_plugin",
      last_tool: "session_bootstrap"
    });
    expect(first.recent_events.at(-1)?.summary).toBe("Codex session started");

    const second = firstJson<{ revision: number; bootstrap_event_created: boolean }>(
      await connected.client.callTool({
        name: "session_bootstrap",
        arguments: { project_id: projectId, source: "codex_plugin" }
      })
    );
    expect(second.bootstrap_event_created).toBe(false);
    expect(second.revision).toBe(first.revision);

    const summary = getSessionSummary(root, projectId);
    expect(summary.recent_events.filter((event) => event.summary === "Codex session started")).toHaveLength(1);
  });

  it("reads and writes shared sessions through MCP using the same store as CLI and HTTP adapters", async () => {
    const root = makeTempRoot();
    const projectId = "AgentBridge";
    const connected = await createConnectedClient(root);
    servers.push(connected);

    const active = firstJson<{
      project_id: string;
      session_id: string;
      revision: number;
      summary: { session_id: string; revision: number };
    }>(
      await connected.client.callTool({
        name: "session_active",
        arguments: { project_id: projectId }
      })
    );
    expect(active.project_id).toBe(projectId);
    expect(active.session_id).toBe(active.summary.session_id);

    const summary = firstJson<{ summary: { session_id: string; revision: number } }>(
      await connected.client.callTool({
        name: "session_summary",
        arguments: { project_id: projectId }
      })
    );
    expect(summary.summary.session_id).toBe(active.session_id);
    expect(summary.summary.revision).toBe(active.revision);

    const mcpEvent = firstJson<{ event: { summary: string }; revision: number }>(
      await connected.client.callTool({
        name: "session_append_event",
        arguments: {
          project_id: projectId,
          actor: "codex",
          type: "note",
          summary: "MCP wrote event OPENAI_API_KEY=sk-test-secret PASSWORD=hunter2 token=abc123",
          details: "Bearer secret_should_not_be_stored"
        }
      })
    );
    expect(mcpEvent.event.summary).toContain("[REDACTED]");
    expect(mcpEvent.event.summary).not.toContain("sk-test-secret");
    expect(getSessionSummary(root, projectId).recent_events.at(-1)?.summary).toContain("MCP wrote event");

    const httpLikeEvent = appendSessionEvent(root, projectId, {
      actor: "chatgpt",
      type: "decision",
      summary: "HTTP-like write visible through MCP"
    });
    const storedActivity = appendSessionActivity(root, projectId, {
      actor: "codex",
      source: "cli",
      kind: "file_verify",
      status: "success",
      summary: "CLI activity visible through MCP",
      paths: ["README.md"],
      metadata: { content: "raw content should not store", bytes: 10 }
    });
    const activity = firstJson<{ activities: Array<{ kind: string; summary: string; metadata: Record<string, unknown> }> }>(
      await connected.client.callTool({
        name: "session_activity",
        arguments: { project_id: projectId, limit: 5 }
      })
    );
    expect(activity.activities.at(-1)).toMatchObject({
      kind: "file_verify",
      summary: "CLI activity visible through MCP"
    });
    expect(activity.activities.at(-1)?.metadata).not.toHaveProperty("content");

    execFileSync("git", ["init"], { cwd: root, stdio: "ignore", windowsHide: true });
    fs.writeFileSync(path.join(root, ".gitignore"), ".agentbridge/\n", "utf8");
    fs.writeFileSync(path.join(root, "mcp-gap.txt"), "metadata gap only\n", "utf8");
    const reconciled = firstJson<{ snapshot: { changed_count: number }; unlogged_changes: Array<{ path: string }>; activities_written: Array<{ kind: string; paths: string[] }> }>(
      await connected.client.callTool({
        name: "session_reconcile",
        arguments: { project_id: projectId }
      })
    );
    expect(reconciled.snapshot.changed_count).toBeGreaterThan(0);
    expect(reconciled.unlogged_changes.some((file) => file.path === "mcp-gap.txt")).toBe(true);
    expect(reconciled.activities_written.some((activity) => activity.kind === "workspace_snapshot")).toBe(true);
    expect(reconciled.activities_written.some((activity) => activity.kind === "activity_gap_detected" && activity.paths.includes("mcp-gap.txt"))).toBe(true);

    const updates = firstJson<{ events: Array<{ summary: string }>; activity: Array<{ kind: string }>; to_revision: number }>(
      await connected.client.callTool({
        name: "session_updates",
        arguments: { project_id: projectId, since_revision: mcpEvent.revision }
      })
    );
    expect(updates.to_revision).toBeGreaterThanOrEqual(storedActivity.revision);
    expect(updates.events.some((event) => event.summary === "HTTP-like write visible through MCP")).toBe(true);
    expect(updates.activity.some((item) => item.kind === "file_verify")).toBe(true);

    const mcpHandoff = firstJson<{ handoff: { id: string; title: string }; revision: number }>(
      await connected.client.callTool({
        name: "session_add_handoff",
        arguments: {
          project_id: projectId,
          from: "codex",
          to: "chatgpt",
          title: "MCP handoff test",
          message: "Codex created this handoff through MCP.",
          constraints: ["No release", "No tag change"],
          expected_output: ["GPT Actions can read this handoff"]
        }
      })
    );
    expect(listSessionHandoffs(root, projectId).handoffs.some((handoff) => handoff.id === mcpHandoff.handoff.id)).toBe(true);

    const httpLikeHandoff = addSessionHandoff(root, projectId, {
      from: "chatgpt",
      to: "codex",
      title: "HTTP-like handoff",
      message: "Visible through MCP handoff listing."
    });
    const handoffs = firstJson<{ handoffs: Array<{ id: string; status: string; title: string }> }>(
      await connected.client.callTool({
        name: "session_list_handoffs",
        arguments: { project_id: projectId, status: "active" }
      })
    );
    expect(handoffs.handoffs.some((handoff) => handoff.id === httpLikeHandoff.handoff.id)).toBe(true);

    await connected.client.callTool({
      name: "session_update_handoff",
      arguments: {
        project_id: projectId,
        handoff_id: httpLikeHandoff.handoff.id,
        status: "acknowledged",
        result_summary: "Codex acknowledged via MCP."
      }
    });
    expect(getSessionSummary(root, projectId).open_handoffs.find((handoff) => handoff.id === httpLikeHandoff.handoff.id)?.status).toBe(
      "acknowledged"
    );

    updateSessionHandoff(root, projectId, mcpHandoff.handoff.id, {
      actor: "chatgpt",
      status: "done",
      result_summary: "CLI-like update visible through MCP."
    });
    const mcpSummary = firstJson<{ summary: { open_handoffs: Array<{ id: string; status: string }> } }>(
      await connected.client.callTool({
        name: "session_summary",
        arguments: { project_id: projectId }
      })
    );
    expect(mcpSummary.summary.open_handoffs.find((handoff) => handoff.id === mcpHandoff.handoff.id)).toBeUndefined();

    const goal = firstJson<{ summary: { current_goal: string; phase: string; current_status: string } }>(
      await connected.client.callTool({
        name: "session_set_goal",
        arguments: {
          project_id: projectId,
          goal: "Test v0.6-gamma MCP session tools",
          phase: "review",
          status: "in_progress"
        }
      })
    );
    expect(goal.summary).toMatchObject({
      current_goal: "Test v0.6-gamma MCP session tools",
      phase: "review",
      current_status: "in_progress"
    });

    const check = firstJson<{ check: { type: string; status: string; summary: string; command?: string } }>(
      await connected.client.callTool({
        name: "session_append_check",
        arguments: {
          project_id: projectId,
          type: "test",
          status: "pass",
          summary: "MCP test passed with OPENAI_API_KEY=sk-test_should_not_leak",
          command: "npm test --token=abc_should_not_leak",
          exit_code: 0,
          duration_ms: 25
        }
      })
    );
    expect(check.check.summary).toContain("[REDACTED]");
    expect(check.check.command).toContain("[REDACTED]");

    const summaryWithCheck = firstJson<{ summary: { recent_checks: Array<{ type: string; status: string; summary: string }> } }>(
      await connected.client.callTool({
        name: "session_summary",
        arguments: { project_id: projectId }
      })
    );
    expect(summaryWithCheck.summary.recent_checks.at(-1)).toMatchObject({ type: "test", status: "pass" });
    expect(JSON.stringify(summaryWithCheck)).not.toContain("sk-test_should_not_leak");
    expect(JSON.stringify(summaryWithCheck)).not.toContain("abc_should_not_leak");
  });

  it("rejects invalid shared session MCP inputs", async () => {
    const root = makeTempRoot();
    const connected = await createConnectedClient(root);
    servers.push(connected);

    await expectToolFailure(() =>
      connected.client.callTool({
        name: "session_append_event",
        arguments: { project_id: "AgentBridge", actor: "nobody", type: "note", summary: "bad actor" }
      })
    );
    await expectToolFailure(() =>
      connected.client.callTool({
        name: "session_append_event",
        arguments: { project_id: "AgentBridge", actor: "codex", type: "scan", summary: "bad type" }
      })
    );
    await expectToolFailure(() =>
      connected.client.callTool({
        name: "session_update_handoff",
        arguments: { project_id: "AgentBridge", handoff_id: "handoff_000001", status: "running" }
      })
    );
  });
});
