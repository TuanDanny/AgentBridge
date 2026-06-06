#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function hasCli(root) {
  return fs.existsSync(path.join(root, "dist", "cli.js"));
}

function findRepoRoot(start) {
  let current = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(current, "package.json")) && hasCli(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function resolveAgentBridgeRoot() {
  const hookFile = fileURLToPath(import.meta.url);
  const pluginRoot = path.resolve(path.dirname(hookFile), "..");
  const candidates = [
    process.env.AGENTBRIDGE_ROOT,
    process.env.CODEXLINK_AGENTBRIDGE_ROOT,
    path.resolve(pluginRoot, "..", ".."),
    findRepoRoot(pluginRoot),
    findRepoRoot(process.cwd())
  ].filter(Boolean);

  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    if (hasCli(root)) {
      return root;
    }
  }
  return undefined;
}

function main() {
  if (process.argv.includes("--dry-run")) {
    const root = resolveAgentBridgeRoot();
    console.log(
      JSON.stringify(
        {
          ok: Boolean(root),
          dry_run: true,
          action: "mcp_stdio",
          root_found: Boolean(root)
        },
        null,
        2
      )
    );
    return;
  }

  const root = resolveAgentBridgeRoot();
  if (!root) {
    console.error("CodexLink MCP warning: set AGENTBRIDGE_ROOT or build AgentBridge before enabling the plugin.");
    process.exit(1);
  }

  const child = spawn(process.execPath, [path.join(root, "dist", "cli.js"), "mcp"], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main();
