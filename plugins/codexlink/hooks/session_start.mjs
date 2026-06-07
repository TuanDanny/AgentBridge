#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_ERROR_CHARS = 600;
const SAFE_PROJECT_ID = /^[A-Za-z0-9._-]{1,80}$/;

function parseArgs(argv) {
  const args = {
    dryRun: false,
    json: false,
    projectId: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run") {
      args.dryRun = true;
    } else if (value === "--json") {
      args.json = true;
    } else if (value === "--project-id") {
      args.projectId = argv[index + 1];
      index += 1;
    } else if (value === "--timeout-ms") {
      const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        args.timeoutMs = Math.min(parsed, 30000);
      }
      index += 1;
    }
  }
  return args;
}

function hookPaths() {
  const hookFile = fileURLToPath(import.meta.url);
  const hookDir = path.dirname(hookFile);
  const pluginRoot = path.resolve(hookDir, "..");
  return { hookFile, hookDir, pluginRoot };
}

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

function resolveAgentBridgeRoot(pluginRoot) {
  const repoRelativeRoot = path.resolve(pluginRoot, "..", "..");
  const candidates = [
    process.env.AGENTBRIDGE_ROOT,
    process.env.CODEXLINK_AGENTBRIDGE_ROOT,
    repoRelativeRoot,
    findRepoRoot(pluginRoot),
    findRepoRoot(process.cwd()),
    process.cwd()
  ].filter(Boolean);

  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    if (hasCli(root)) {
      return { ok: true, root };
    }
  }

  return {
    ok: false,
    message: "CodexLink could not find AgentBridge dist/cli.js. Set AGENTBRIDGE_ROOT or run npm run build."
  };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function safeProjectId(value) {
  return typeof value === "string" && SAFE_PROJECT_ID.test(value) ? value : undefined;
}

function projectIdFromProjectJson(projectRoot) {
  const value = readJson(path.join(projectRoot, ".agentbridge", "project.json"));
  return safeProjectId(value?.id) ?? safeProjectId(value?.project_id);
}

function activeProjectId(agentBridgeRoot) {
  const value = readJson(path.join(agentBridgeRoot, ".agentbridge", "active_project.json"));
  return safeProjectId(value?.active_project?.id) ?? safeProjectId(value?.id);
}

function registeredProjectIdForRoot(agentBridgeRoot, projectRoot) {
  const registry = readJson(path.join(agentBridgeRoot, ".agentbridge", "projects.json"));
  const projects = Array.isArray(registry?.projects) ? registry.projects : [];
  const normalizedProjectRoot = path.resolve(projectRoot).toLowerCase();
  const match = projects.find((project) => {
    return typeof project?.root === "string" && path.resolve(project.root).toLowerCase() === normalizedProjectRoot;
  });
  return safeProjectId(match?.id);
}

function resolveProjectRoot() {
  return path.resolve(
    process.env.CODEXLINK_PROJECT_ROOT ??
      process.env.AGENTBRIDGE_PROJECT_ROOT ??
      process.env.CODEX_WORKSPACE_ROOT ??
      process.env.WORKSPACE_ROOT ??
      process.cwd()
  );
}

function resolveProjectId(agentBridgeRoot, projectRoot, explicitProjectId) {
  return (
    safeProjectId(explicitProjectId) ??
    safeProjectId(process.env.CODEXLINK_PROJECT_ID) ??
    safeProjectId(process.env.AGENTBRIDGE_PROJECT_ID) ??
    projectIdFromProjectJson(projectRoot) ??
    registeredProjectIdForRoot(agentBridgeRoot, projectRoot) ??
    activeProjectId(agentBridgeRoot) ??
    safeProjectId(path.basename(projectRoot))
  );
}

function runBootstrap(agentBridgeRoot, projectId, timeoutMs) {
  const cliPath = path.join(agentBridgeRoot, "dist", "cli.js");
  const args = [cliPath, "session", "bootstrap", projectId, "--source", "codex_plugin", "--json"];
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: agentBridgeRoot, timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          ok: false,
          error: sanitizeShort(stderr || error.message || "bootstrap failed")
        });
        return;
      }
      try {
        resolve({ ok: true, result: JSON.parse(stdout) });
      } catch {
        resolve({ ok: false, error: "bootstrap output was not valid JSON" });
      }
    });
  });
}

function sanitizeShort(input) {
  return String(input)
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(?:local_token|OPENAI_API_KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*\S+/gi, "[REDACTED]")
    .slice(0, MAX_ERROR_CHARS)
    .trim();
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printStatus(message, json, payload) {
  if (json) {
    printJson(payload);
  } else {
    console.log(message);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { pluginRoot } = hookPaths();
  const root = resolveAgentBridgeRoot(pluginRoot);
  if (!root.ok) {
    printStatus(`CodexLink warning: ${root.message}`, args.json, { ok: false, warning: root.message });
    return;
  }

  const projectRoot = resolveProjectRoot();
  const projectId = resolveProjectId(root.root, projectRoot, args.projectId);
  if (!projectId) {
    printStatus("CodexLink warning: could not resolve a safe project id.", args.json, {
      ok: false,
      warning: "could not resolve a safe project id"
    });
    return;
  }

  if (args.dryRun) {
    printStatus(`CodexLink dry run: project=${projectId} action=session_bootstrap`, args.json, {
      ok: true,
      dry_run: true,
      project_id: projectId,
      action: "session_bootstrap",
      source: "codex_plugin",
      will_call_bootstrap: true
    });
    return;
  }

  const bootstrap = await runBootstrap(root.root, projectId, args.timeoutMs);
  if (!bootstrap.ok) {
    printStatus(`CodexLink warning: ${bootstrap.error}`, args.json, bootstrap);
    return;
  }

  const result = bootstrap.result;
  printStatus(
    `CodexLink session bootstrapped: project=${result.project_id} revision=${result.revision} action=${result.recommended_next_action}`,
    args.json,
    {
      ok: true,
      project_id: result.project_id,
      session_id: result.session_id,
      revision: result.revision,
      bootstrap_event_created: result.bootstrap_event_created,
      recommended_next_action: result.recommended_next_action
    }
  );
}

main().catch((error) => {
  console.log(`CodexLink warning: ${sanitizeShort(error?.message ?? error)}`);
});
