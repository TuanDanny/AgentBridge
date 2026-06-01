import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentBridgeMcpServer } from "../src/mcpServer.js";

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
});
