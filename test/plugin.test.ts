import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const pluginRoot = path.resolve("plugins", "codexlink");
const pluginJsonPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const mcpJsonPath = path.join(pluginRoot, ".mcp.json");
const hooksJsonPath = path.join(pluginRoot, "hooks", "hooks.json");
const sessionStartPath = path.join(pluginRoot, "hooks", "session_start.mjs");
const mcpStdioPath = path.join(pluginRoot, "hooks", "mcp_stdio.mjs");
const skillPath = path.join(pluginRoot, "skills", "codexlink-session", "SKILL.md");
const marketplacePath = path.resolve(".agents", "plugins", "marketplace.json");

const tempRoots: string[] = [];

function readJson<T = Record<string, unknown>>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function runNode(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync(process.execPath, args, {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    windowsHide: true
  });
}

function makeTempAgentBridgeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-plugin-hook-"));
  tempRoots.push(root);
  fs.cpSync(path.resolve("dist"), path.join(root, "dist"), { recursive: true });
  fs.symlinkSync(
    path.resolve("node_modules"),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir"
  );
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("CodexLink local plugin", () => {
  it("defines valid plugin, MCP, hook, and marketplace JSON", () => {
    const plugin = readJson<{
      name: string;
      version: string;
      description: string;
      skills: string;
      mcpServers: string;
      hooks: string;
    }>(pluginJsonPath);
    expect(plugin.name).toBe("codexlink");
    expect(plugin.version).toBe("0.7.0-alpha");
    expect(plugin.description).toContain("Auto-bootstrap");
    expect(plugin.skills).toBe("./skills");
    expect(plugin.mcpServers).toBe("./.mcp.json");
    expect(plugin.hooks).toBe("./hooks/hooks.json");

    const mcp = readJson<{ mcp_servers: Record<string, { command: string; args: string[] }> }>(mcpJsonPath);
    expect(mcp.mcp_servers.agentbridge.command).toBe("node");
    expect(mcp.mcp_servers.agentbridge.args).toEqual(["${PLUGIN_ROOT}/hooks/mcp_stdio.mjs"]);

    const hooks = readJson<{ hooks: { SessionStart: Array<{ hooks: Array<{ type: string; command: string; statusMessage: string }> }> } }>(
      hooksJsonPath
    );
    expect(hooks.hooks.SessionStart[0].hooks[0]).toMatchObject({
      type: "command",
      command: "node ${PLUGIN_ROOT}/hooks/session_start.mjs",
      statusMessage: "Starting CodexLink shared session"
    });

    const marketplace = readJson<{ plugins: Array<{ name: string; source: { source: string; path: string } }> }>(marketplacePath);
    expect(marketplace.plugins[0]).toMatchObject({
      name: "codexlink",
      source: {
        source: "local",
        path: "./plugins/codexlink"
      }
    });
  });

  it("keeps plugin metadata free of secrets and HTTP MCP claims", () => {
    const content = [
      fs.readFileSync(pluginJsonPath, "utf8"),
      fs.readFileSync(mcpJsonPath, "utf8"),
      fs.readFileSync(hooksJsonPath, "utf8"),
      fs.readFileSync(marketplacePath, "utf8")
    ].join("\n");

    expect(content).not.toContain(".agentbridge/local_token");
    expect(content).not.toContain("local_token");
    expect(content).not.toContain("Bearer ");
    expect(content).not.toContain("OPENAI_API_KEY");
    expect(content).not.toContain("sk-");
    expect(content).not.toContain('"http://');
    expect(content).not.toContain('"https://');
    expect(content).not.toContain('"/mcp"');
  });

  it("ships Codex session skill instructions with required safety rules", () => {
    const skill = fs.readFileSync(skillPath, "utf8");

    expect(skill).toContain("session_bootstrap");
    expect(skill).toContain("shared session");
    expect(skill).toContain("Do not store raw file content");
    expect(skill).toContain("secrets");
    expect(skill).toContain("tokens");
    expect(skill).toContain("Do not push, tag, release");
    expect(skill).toContain("handoff");
    expect(skill).toContain("session_context");
    expect(skill).toContain("session_timeline");
    expect(skill).toContain("session_reconcile");
    expect(skill).toContain("task_complete");
  });

  it("runs SessionStart dry-run without printing secrets", () => {
    const output = runNode([sessionStartPath, "--dry-run", "--json"]);
    const parsed = JSON.parse(output) as {
      ok: boolean;
      dry_run: boolean;
      action: string;
      will_call_bootstrap: boolean;
    };

    expect(parsed).toMatchObject({
      ok: true,
      dry_run: true,
      action: "session_bootstrap",
      will_call_bootstrap: true
    });
    expect(output).not.toContain("local_token");
    expect(output).not.toContain("Bearer ");
    expect(output).not.toContain("OPENAI_API_KEY");
    expect(output).not.toContain("sk-");
  });

  it("runs the hook against an isolated AgentBridge root and does not spam bootstrap events", () => {
    const root = makeTempAgentBridgeRoot();
    const projectId = path.basename(root);
    const env = {
      AGENTBRIDGE_ROOT: root,
      CODEXLINK_PROJECT_ROOT: root,
      CODEXLINK_PROJECT_ID: projectId
    };

    const first = JSON.parse(runNode([sessionStartPath, "--json"], { env })) as {
      ok: boolean;
      project_id: string;
      revision: number;
      bootstrap_event_created: boolean;
      recommended_next_action: string;
    };
    const second = JSON.parse(runNode([sessionStartPath, "--json"], { env })) as {
      ok: boolean;
      project_id: string;
      revision: number;
      bootstrap_event_created: boolean;
    };

    expect(first.ok).toBe(true);
    expect(first.project_id).toBe(projectId);
    expect(first.bootstrap_event_created).toBe(true);
    expect(first.recommended_next_action).toBe("set_goal_or_ask_user");
    expect(second.ok).toBe(true);
    expect(second.project_id).toBe(projectId);
    expect(second.bootstrap_event_created).toBe(false);
    expect(second.revision).toBe(first.revision);

    const sessionDir = path.join(root, ".agentbridge", "sessions", projectId, `sess_${projectId}_shared`);
    const eventText = fs.readFileSync(path.join(sessionDir, "events.jsonl"), "utf8");
    expect(eventText.match(/Codex session started/g)).toHaveLength(1);
    expect(eventText).not.toContain("local_token");
    expect(eventText).not.toContain("Bearer ");
    expect(eventText).not.toContain("OPENAI_API_KEY");
    expect(eventText).not.toContain("sk-");
  });

  it("supports MCP stdio dry-run root detection", () => {
    const root = makeTempAgentBridgeRoot();
    const output = runNode([mcpStdioPath, "--dry-run"], {
      env: {
        AGENTBRIDGE_ROOT: root
      }
    });
    const parsed = JSON.parse(output) as { ok: boolean; dry_run: boolean; action: string; root_found: boolean };

    expect(parsed).toMatchObject({
      ok: true,
      dry_run: true,
      action: "mcp_stdio",
      root_found: true
    });
  });
});
