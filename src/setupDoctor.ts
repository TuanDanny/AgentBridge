import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { probeServer } from "./daemonClient.js";
import { ensureDir, pathExists, readJsonIfExists, writeText } from "./fsx.js";
import { bridgePath, getBridgeDir, resolveProjectRoot } from "./paths.js";
import { readActiveProject } from "./activeProject.js";
import { listProjects, projectIdFromRoot } from "./registry.js";
import { bootstrapSession, getRecentActivity, getSessionCompactContext, getSessionSummary } from "./sessionStore.js";
import { findWorkspaceActivityGaps } from "./workspaceActivity.js";
import {
  hasLauncherConfig,
  isQuickTunnelUrl,
  launcherWarnings,
  readLauncherConfig,
  RELAY_MODE_WARNING,
  setupLauncher,
  type LauncherSetupOptions
} from "./launcher.js";
import { validateRelayProtocolSpec } from "./relayProtocol.js";
import { readRelayPairingStatus } from "./relayPairing.js";

export type DoctorStatus = "PASS" | "WARN" | "FAIL";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  message: string;
  next_step: string;
}

export interface DoctorResult {
  ok: boolean;
  root: string;
  project_id: string;
  checks: DoctorCheck[];
  recommended_next_action: string;
}

export interface SetupResult {
  ok: boolean;
  dry_run: boolean;
  root: string;
  checks: DoctorCheck[];
  changed_files: string[];
  next_steps: string[];
}

interface DoctorOptions {
  projectId?: string;
  launcher?: boolean;
}

interface SetupOptions {
  dryRun?: boolean;
  host?: string;
  port?: number;
  publicUrl?: string;
}

const PLUGIN_FILES = [
  "plugins/codexlink/.codex-plugin/plugin.json",
  "plugins/codexlink/.mcp.json",
  "plugins/codexlink/hooks/hooks.json",
  "plugins/codexlink/hooks/session_start.mjs",
  "plugins/codexlink/hooks/mcp_stdio.mjs",
  "plugins/codexlink/skills/codexlink-session/SKILL.md",
  ".agents/plugins/marketplace.json"
];

const SESSION_REQUEST_BODY_PATHS = [
  "/chatgpt/projects/{projectId}/session/events",
  "/chatgpt/projects/{projectId}/session/handoffs",
  "/chatgpt/projects/{projectId}/session/handoffs/{handoffId}",
  "/chatgpt/projects/{projectId}/session/goal"
];

function check(name: string, status: DoctorStatus, message: string, nextStep: string): DoctorCheck {
  return { name, status, message, next_step: nextStep };
}

function pass(name: string, message: string, nextStep = "No action needed."): DoctorCheck {
  return check(name, "PASS", message, nextStep);
}

function warn(name: string, message: string, nextStep: string): DoctorCheck {
  return check(name, "WARN", message, nextStep);
}

function fail(name: string, message: string, nextStep: string): DoctorCheck {
  return check(name, "FAIL", message, nextStep);
}

function jsonFile(root: string, relativePath: string): unknown | undefined {
  const filePath = path.join(root, relativePath);
  try {
    return readJsonIfExists(filePath);
  } catch {
    return undefined;
  }
}

function parseJsonCheck(root: string, relativePath: string, label: string): DoctorCheck {
  const filePath = path.join(root, relativePath);
  if (!pathExists(filePath)) {
    return fail(label, `Missing ${relativePath}.`, `Run node dist/cli.js setup codex-plugin.`);
  }
  try {
    JSON.parse(fs.readFileSync(filePath, "utf8"));
    return pass(label, `${relativePath} parses as JSON.`);
  } catch (error) {
    return fail(label, `${relativePath} is not valid JSON.`, `Fix ${relativePath}: ${shortError(error)}`);
  }
}

function fileExistsCheck(root: string, relativePath: string, label: string): DoctorCheck {
  return pathExists(path.join(root, relativePath))
    ? pass(label, `${relativePath} exists.`)
    : fail(label, `Missing ${relativePath}.`, "Rebuild or reinstall the CodexLink plugin files.");
}

function nodeVersionCheck(): DoctorCheck {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  return major >= 18
    ? pass("node_version", `Node ${process.version} is supported.`)
    : fail("node_version", `Node ${process.version} is too old.`, "Install Node.js 18 or newer.");
}

function packageScriptsCheck(root: string): DoctorCheck {
  const pkg = jsonFile(root, "package.json") as { scripts?: Record<string, string> } | undefined;
  if (!pkg?.scripts) {
    return fail("package_scripts", "package.json scripts are missing.", "Restore package.json scripts.");
  }
  const missing = ["build", "test", "generate:openapi"].filter((name) => !pkg.scripts?.[name]);
  return missing.length
    ? fail("package_scripts", `Missing scripts: ${missing.join(", ")}.`, "Restore package.json scripts.")
    : pass("package_scripts", "build, test, and generate:openapi scripts exist.");
}

function distCheck(root: string): DoctorCheck {
  return pathExists(path.join(root, "dist", "cli.js"))
    ? pass("dist_build", "dist/cli.js exists.")
    : fail("dist_build", "dist/cli.js is missing.", "Run npm run build.");
}

function resolveDoctorProjectId(root: string, explicitProjectId?: string): string {
  if (explicitProjectId) {
    return explicitProjectId;
  }
  const active = readActiveProject(root).active_project;
  if (active?.id) {
    return active.id;
  }
  const currentProjectId = projectIdFromRoot(root);
  const projects = listProjects(root);
  const currentRegistered = projects.find((project) => project.id.toLowerCase() === currentProjectId.toLowerCase());
  if (currentRegistered) {
    return currentRegistered.id;
  }
  if (projects.length === 1) {
    return projects[0].id;
  }
  return currentProjectId;
}

function pluginValidationChecks(root: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  checks.push(parseJsonCheck(root, "plugins/codexlink/.codex-plugin/plugin.json", "plugin_json"));
  checks.push(parseJsonCheck(root, "plugins/codexlink/.mcp.json", "mcp_json"));
  checks.push(parseJsonCheck(root, "plugins/codexlink/hooks/hooks.json", "hooks_json"));
  checks.push(parseJsonCheck(root, ".agents/plugins/marketplace.json", "marketplace_json"));
  checks.push(fileExistsCheck(root, "plugins/codexlink/hooks/session_start.mjs", "session_start_hook"));
  checks.push(fileExistsCheck(root, "plugins/codexlink/hooks/mcp_stdio.mjs", "mcp_stdio_hook"));
  checks.push(fileExistsCheck(root, "plugins/codexlink/skills/codexlink-session/SKILL.md", "codexlink_skill"));

  const plugin = jsonFile(root, "plugins/codexlink/.codex-plugin/plugin.json") as
    | { skills?: string; mcpServers?: string; hooks?: string }
    | undefined;
  if (plugin) {
    checks.push(
      plugin.skills === "./skills" && plugin.mcpServers === "./.mcp.json" && plugin.hooks === "./hooks/hooks.json"
        ? pass("plugin_manifest_refs", "plugin.json references skills, MCP config, and hooks.")
        : fail("plugin_manifest_refs", "plugin.json references are incomplete.", "Run setup codex-plugin or restore plugin.json.")
    );
  }

  const marketplace = jsonFile(root, ".agents/plugins/marketplace.json") as
    | { plugins?: Array<{ name?: string; source?: { path?: string } }> }
    | undefined;
  const marketplaceEntry = marketplace?.plugins?.find((pluginEntry) => pluginEntry.name === "codexlink");
  checks.push(
    marketplaceEntry?.source?.path === "./plugins/codexlink"
      ? pass("marketplace_entry", "Local marketplace points to ./plugins/codexlink.")
      : fail("marketplace_entry", "CodexLink marketplace entry is missing or points elsewhere.", "Run setup codex-plugin.")
  );

  return checks;
}

function openApiChecks(root: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const files = ["openapi.agentbridge.json", "openapi.agentbridge.gpt-actions.json"];
  for (const file of files) {
    let spec: { paths?: Record<string, Record<string, { operationId?: string; requestBody?: unknown }>> } | undefined;
    try {
      spec = readJsonIfExists(path.join(root, file));
    } catch {
      spec = undefined;
    }
    if (!spec) {
      checks.push(fail(`openapi_${file}`, `${file} is missing or invalid.`, "Run npm run generate:openapi."));
      continue;
    }
    if (spec.paths?.["/mcp"]) {
      checks.push(fail(`openapi_${file}`, `${file} contains /mcp.`, "Remove fake HTTP MCP paths."));
      continue;
    }
    const missing = SESSION_REQUEST_BODY_PATHS.filter((pathName) => !hasExplicitJsonRequestProperties(spec, pathName));
    if (missing.length) {
      checks.push(
        fail(
          `openapi_${file}`,
          `${file} is missing explicit requestBody properties for ${missing.length} session write endpoint(s).`,
          "Run npm run generate:openapi."
        )
      );
      continue;
    }
    checks.push(pass(`openapi_${file}`, `${file} parses and has explicit session requestBody schemas.`));
  }
  return checks;
}

function hasExplicitJsonRequestProperties(
  spec: { paths?: Record<string, Record<string, { requestBody?: unknown }>> },
  pathName: string
): boolean {
  const operation = spec.paths?.[pathName]?.post;
  const requestBody = operation?.requestBody as
    | { content?: { "application/json"?: { schema?: { type?: string; properties?: unknown; additionalProperties?: unknown } } } }
    | undefined;
  const schema = requestBody?.content?.["application/json"]?.schema;
  return schema?.type === "object" && Boolean(schema.properties) && schema.additionalProperties === false;
}

function localTokenCheck(root: string): DoctorCheck {
  return pathExists(bridgePath(root, "local_token"))
    ? pass("local_auth_presence", "Local auth token file exists. Value was not read or printed.")
    : warn("local_auth_presence", "Local auth token file is missing.", "Start AgentBridge once before using GPT Actions auth.");
}

async function localServerCheck(root: string): Promise<DoctorCheck> {
  const probe = await probeServer(root);
  if (probe.running && probe.info) {
    return pass("local_server_health", `Local server is healthy at ${probe.info.host}:${probe.info.port}.`);
  }
  return warn("local_server_health", "Local server is not running or server.json is stale.", "Run node dist/cli.js start --host 127.0.0.1 --port 7777.");
}

async function tunnelCheck(root: string): Promise<DoctorCheck> {
  const remote = readJsonIfExists<{ public_url?: string; url?: string }>(bridgePath(root, "remote_bridge.json"));
  const publicUrl = remote?.public_url ?? remote?.url;
  if (!publicUrl) {
    return warn("tunnel_health", "No remote_bridge.json public URL is registered.", "Run tunnel guide/register when GPT Actions needs a public URL.");
  }
  try {
    const response = await fetch(`${publicUrl.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(3000) });
    if (response.ok) {
      return pass("tunnel_health", "Public tunnel /health is reachable.");
    }
    return warn("tunnel_health", diagnoseHttpStatus(response.status), "Restart tunnel and run setup gpt-actions.");
  } catch (error) {
    return warn("tunnel_health", diagnoseSetupIssue("tunnel_fetch_error", shortError(error)), "Restart tunnel and run setup gpt-actions.");
  }
}

function launcherConfigCheck(root: string): DoctorCheck {
  if (!hasLauncherConfig(root)) {
    return warn("launcher_config", "No .agentbridge/launcher-config.json is configured.", "Run node dist/cli.js setup launcher.");
  }
  try {
    const config = readLauncherConfig(root);
    return config
      ? pass("launcher_config", "Launcher config exists and validates.")
      : warn("launcher_config", "Launcher config is missing.", "Run node dist/cli.js setup launcher.");
  } catch (error) {
    return fail("launcher_config", `Launcher config is invalid: ${shortError(error)}`, "Run node dist/cli.js setup launcher with safe values.");
  }
}

function launcherPublicUrlCheck(root: string): DoctorCheck {
  try {
    const config = readLauncherConfig(root);
    if (!config?.publicBaseUrl) {
      return warn("launcher_public_url", "No publicBaseUrl is configured for one-click GPT Actions.", "Use a stable HTTPS URL with setup launcher.");
    }
    const warnings = launcherWarnings(config);
    const quickWarning = warnings.find((item) => item.includes("Quick Tunnel URL"));
    if (quickWarning) {
      return warn("launcher_public_url", quickWarning, "Use a stable tunnel/domain for daily GPT Actions.");
    }
    return pass("launcher_public_url", "Stable-looking publicBaseUrl is configured.");
  } catch (error) {
    return warn("launcher_public_url", `Could not read launcher public URL: ${shortError(error)}`, "Run setup launcher.");
  }
}

async function launcherPublicHealthCheck(root: string): Promise<DoctorCheck> {
  try {
    const config = readLauncherConfig(root);
    if (!config?.publicBaseUrl) {
      return warn("launcher_public_health", "No publicBaseUrl configured, so public /health was not checked.", "Configure a stable public URL.");
    }
    const response = await fetch(`${config.publicBaseUrl.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(2500) });
    return response.ok
      ? pass("launcher_public_health", "Configured publicBaseUrl /health is reachable.")
      : warn("launcher_public_health", diagnoseHttpStatus(response.status), "Check tunnel/domain forwarding to local AgentBridge.");
  } catch (error) {
    return warn("launcher_public_health", `Configured publicBaseUrl /health is not reachable: ${shortError(error)}`, "Start tunnel/domain and retry doctor --launcher.");
  }
}

function launcherGptUrlCheck(root: string): DoctorCheck {
  try {
    const config = readLauncherConfig(root);
    return config?.gptUrl
      ? pass("launcher_gpt_url", "GPT URL is configured for one-click browser open.")
      : warn("launcher_gpt_url", "No GPT URL configured; launcher will copy the greeting only.", "Add --gpt-url if you want the launcher to open GPTs.");
  } catch (error) {
    return warn("launcher_gpt_url", `Could not inspect GPT URL: ${shortError(error)}`, "Run setup launcher.");
  }
}

function launcherReadinessCheck(root: string): DoctorCheck {
  try {
    const config = readLauncherConfig(root);
    if (!config) {
      return warn("launcher_one_click_readiness", "Launcher config is missing.", "Run node dist/cli.js setup launcher.");
    }
    if (!pathExists(path.join(root, "dist", "cli.js"))) {
      return fail("launcher_one_click_readiness", "dist/cli.js is missing.", "Run npm run build before using start-codexlink.bat.");
    }
    if (!config.publicBaseUrl) {
      return warn("launcher_one_click_readiness", "Local one-click can start, but GPT Actions need a publicBaseUrl.", "Configure a stable HTTPS public URL.");
    }
    if (isQuickTunnelUrl(config.publicBaseUrl)) {
      return warn("launcher_one_click_readiness", "Launcher uses a temporary quick tunnel URL.", "Use a stable tunnel/domain for daily one-click use.");
    }
    return pass("launcher_one_click_readiness", "Launcher config, build, and stable-looking public URL are ready.");
  } catch (error) {
    return fail("launcher_one_click_readiness", `Launcher readiness check failed: ${shortError(error)}`, "Fix launcher config.");
  }
}

function relayPlaceholderCheck(root: string): DoctorCheck {
  const relayConfig = readJsonIfExists<{ enabled?: boolean; mode?: string }>(bridgePath(root, "relay-config.json"));
  const launcher = readLauncherConfig(root);
  const relayProtocol = validateRelayProtocolSpec();
  if (!relayProtocol.ok) {
    return fail("relay_protocol", `Relay protocol spec has ${relayProtocol.errors.length} validation error(s).`, "Fix relay protocol spec before implementing relay.");
  }
  if (launcher?.tunnelMode === "relay" || relayConfig) {
    return warn(
      "relay_mode",
      RELAY_MODE_WARNING,
      "Use a stable HTTPS endpoint now; only continue relay work after protocol, pairing, and security tests are specified."
    );
  }
  return warn("relay_mode", "Relay mode is not configured. This is expected until v1.2 relay work begins.", "Use stable tunnel/domain for GPT Actions today.");
}

function relayPairingCheck(root: string): DoctorCheck {
  const pairing = readRelayPairingStatus(root);
  if (pairing.status === "missing") {
    return warn("relay_pairing", "No relay pairing metadata exists.", "Run node dist/cli.js relay pairing create when testing relay mode.");
  }
  if (pairing.status === "paired") {
    return pass("relay_pairing", "Relay pairing metadata is paired. Raw pairing code is not stored.");
  }
  if (pairing.status === "pending") {
    return warn("relay_pairing", "Relay pairing code is pending and short-lived.", "Complete pairing before it expires, or revoke it.");
  }
  if (pairing.status === "expired") {
    return warn("relay_pairing", "Relay pairing code is expired.", "Run relay pairing create again when needed.");
  }
  return warn("relay_pairing", "Relay pairing metadata is revoked.", "Create a new pairing code if relay testing is needed.");
}

function sessionChecks(root: string, projectId: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  try {
    const bootstrap = bootstrapSession(root, projectId, {
      actor: "codex",
      client: "codex",
      adapter: "cli",
      source: "doctor",
      mode: "resume"
    });
    checks.push(pass("session_bootstrap", `session_bootstrap works for ${projectId}; revision ${bootstrap.revision}.`));
  } catch (error) {
    checks.push(fail("session_bootstrap", diagnoseSetupIssue("project_not_registered", shortError(error)), "Register/select a valid project."));
    return checks;
  }

  try {
    const summary = getSessionSummary(root, projectId);
    checks.push(pass("session_summary", `Session summary works for ${projectId}; recent_evidence=${summary.recent_evidence.length}, recent_checks=${summary.recent_checks.length}.`));
  } catch (error) {
    checks.push(fail("session_summary", `Session summary failed: ${shortError(error)}`, "Run session bootstrap again or inspect session files."));
  }
  return checks;
}

function hookDryRunCheck(root: string, projectId: string): DoctorCheck {
  const hookPath = path.join(root, "plugins", "codexlink", "hooks", "session_start.mjs");
  if (!pathExists(hookPath)) {
    return fail("hook_dry_run", "SessionStart hook file is missing.", "Run setup codex-plugin.");
  }
  const result = spawnSync(process.execPath, [hookPath, "--dry-run", "--json", "--project-id", projectId], {
    cwd: root,
    env: {
      ...process.env,
      AGENTBRIDGE_ROOT: root,
      CODEXLINK_PROJECT_ID: projectId,
      CODEXLINK_PROJECT_ROOT: root
    },
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (containsSecretLikeText(output)) {
    return fail("hook_dry_run", "Hook dry-run output looked secret-like.", "Inspect hook output policy before trusting it.");
  }
  if (result.status !== 0) {
    return warn("hook_dry_run", `Hook dry-run returned ${result.status ?? "unknown"}.`, "Review hook setup and run node plugins/codexlink/hooks/session_start.mjs --dry-run.");
  }
  try {
    const parsed = JSON.parse(result.stdout) as { ok?: boolean; action?: string };
    return parsed.ok === true && parsed.action === "session_bootstrap"
      ? pass("hook_dry_run", "SessionStart hook dry-run reports session_bootstrap.")
      : warn("hook_dry_run", "Hook dry-run JSON did not confirm session_bootstrap.", "Review hook output.");
  } catch {
    return warn("hook_dry_run", "Hook dry-run did not emit JSON.", "Run hook dry-run manually.");
  }
}

function hookTrustReminder(): DoctorCheck {
  return warn("hook_trust", "Codex plugin hooks require user review/trust once in Codex UI.", "Enable CodexLink plugin and trust the SessionStart hook.");
}

function gitRuntimeIgnoredCheck(root: string): DoctorCheck {
  const result = spawnSync("git", ["status", "--short", "--", ".agentbridge/sessions"], {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true
  });
  if (result.status !== 0) {
    return warn("runtime_git_status", "Could not check git status for .agentbridge/sessions.", "Run git status --short -- .agentbridge/sessions manually.");
  }
  return result.stdout.trim()
    ? fail("runtime_git_status", ".agentbridge/sessions appears in git status.", "Ensure .agentbridge/ is ignored and do not commit runtime files.")
    : pass("runtime_git_status", ".agentbridge/sessions is not tracked or staged.");
}

function activityTraceCoverageCheck(root: string, projectId: string): DoctorCheck {
  try {
    const registered = listProjects(root).find((project) => project.id.toLowerCase() === projectId.toLowerCase());
    const projectRoot = registered?.root ?? root;
    const gaps = findWorkspaceActivityGaps(root, projectRoot, projectId);
    if (gaps.length) {
      const sample = gaps.slice(0, 5).map((file) => file.path).join(", ");
      return warn(
        "activity_trace_coverage",
        `${gaps.length} changed file(s) do not have recent activity metadata${sample ? `: ${sample}` : "."}`,
        `Run node dist/cli.js session reconcile ${projectId} --json.`
      );
    }
    return pass("activity_trace_coverage", "Changed files have recent activity metadata or workspace is clean.");
  } catch (error) {
    return warn("activity_trace_coverage", `Could not check Activity Trace coverage: ${shortError(error)}`, "Run session reconcile manually.");
  }
}

function recentActivityExistsCheck(root: string, projectId: string): DoctorCheck {
  try {
    const activity = getRecentActivity(root, projectId, 10).activities;
    return activity.length
      ? pass("recent_activity", `Recent activity exists (${activity.length} item(s)).`)
      : warn("recent_activity", "No recent activity metadata exists for this project.", `Run node dist/cli.js session bootstrap ${projectId} --json.`);
  } catch (error) {
    return warn("recent_activity", `Could not read recent activity: ${shortError(error)}`, "Run session summary manually.");
  }
}

function staleActivityCheck(root: string, projectId: string): DoctorCheck {
  try {
    const latest = getRecentActivity(root, projectId, 1).activities.at(-1);
    if (!latest) {
      return warn("activity_freshness", "No activity timestamp exists.", `Run node dist/cli.js session bootstrap ${projectId} --json.`);
    }
    const ageMs = Date.now() - Date.parse(latest.time);
    if (!Number.isFinite(ageMs)) {
      return warn("activity_freshness", "Latest activity timestamp could not be parsed.", "Inspect session activity manually.");
    }
    const ageHours = ageMs / (60 * 60 * 1000);
    return ageHours > 24
      ? warn("activity_freshness", "Latest activity is older than 24 hours.", `Run node dist/cli.js session context ${projectId} --compact.`)
      : pass("activity_freshness", "Latest activity is fresh.");
  } catch (error) {
    return warn("activity_freshness", `Could not check activity freshness: ${shortError(error)}`, "Run session activity manually.");
  }
}

function workspaceSnapshotHealthCheck(root: string, projectId: string): DoctorCheck {
  try {
    const context = getSessionCompactContext(root, projectId);
    const snapshot = context.workspace.latest_snapshot;
    if (!snapshot) {
      return warn("workspace_snapshot_health", "No recent workspace_snapshot activity is available.", `Run node dist/cli.js session reconcile ${projectId} --json.`);
    }
    const changedCount = context.workspace.changed_count ?? "unknown";
    const unloggedCount = context.workspace.unlogged_count ?? "unknown";
    return pass("workspace_snapshot_health", `Latest workspace snapshot found; changed=${changedCount}, unlogged=${unloggedCount}.`);
  } catch (error) {
    return warn("workspace_snapshot_health", `Could not inspect compact context: ${shortError(error)}`, "Run session context manually.");
  }
}

function summaryCompactnessCheck(root: string, projectId: string): DoctorCheck {
  try {
    const context = getSessionCompactContext(root, projectId);
    const serialized = JSON.stringify(context);
    if (serialized.length > 60000) {
      return warn("summary_compactness", "Compact context is larger than expected.", "Review recent activity metadata for noisy paths or oversized summaries.");
    }
    return pass("summary_compactness", "Compact context is bounded and parseable.");
  } catch (error) {
    return warn("summary_compactness", `Could not build compact context: ${shortError(error)}`, "Run session context manually.");
  }
}

function runtimeRawContentLeakCheck(root: string): DoctorCheck {
  const sessionRoot = bridgePath(root, "sessions");
  if (!pathExists(sessionRoot)) {
    return pass("runtime_raw_content_scan", "No session runtime directory exists yet.");
  }
  const suspicious = scanRuntimeFiles(sessionRoot, /\.(json|jsonl)$/i, /(diff --git|@@\s|BEGIN (?:RSA |OPENSSH |PRIVATE )?KEY|OPENAI_API_KEY\s*=|Bearer\s+(?!\[REDACTED\])\S{12,})/i, 30);
  return suspicious.length
    ? fail("runtime_raw_content_scan", "Session runtime metadata contains raw diff/key/token-like text.", "Inspect and redact local session runtime files before sharing.")
    : pass("runtime_raw_content_scan", "Session runtime metadata scan found no raw diff/key/token-like text.");
}

function securityOutputPolicyCheck(root: string): DoctorCheck {
  const inspectedFiles = PLUGIN_FILES.map((relativePath) => path.join(root, relativePath)).filter(pathExists);
  const content = inspectedFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  return containsSecretLikeText(content)
    ? fail("plugin_secret_scan", "Plugin/setup files contain secret-like text.", "Remove token references or API keys from plugin files.")
    : pass("plugin_secret_scan", "Plugin/setup files do not contain token values or API keys.");
}

export async function runDoctor(rootInput = process.cwd(), options: DoctorOptions = {}): Promise<DoctorResult> {
  const root = resolveProjectRoot(rootInput);
  const projectId = resolveDoctorProjectId(root, options.projectId);
  const checks: DoctorCheck[] = [
    nodeVersionCheck(),
    packageScriptsCheck(root),
    distCheck(root),
    ...pluginValidationChecks(root),
    localTokenCheck(root),
    ...openApiChecks(root),
    ...sessionChecks(root, projectId),
    recentActivityExistsCheck(root, projectId),
    staleActivityCheck(root, projectId),
    activityTraceCoverageCheck(root, projectId),
    workspaceSnapshotHealthCheck(root, projectId),
    summaryCompactnessCheck(root, projectId),
    hookDryRunCheck(root, projectId),
    hookTrustReminder(),
    gitRuntimeIgnoredCheck(root),
    runtimeRawContentLeakCheck(root),
    securityOutputPolicyCheck(root),
    await localServerCheck(root),
    await tunnelCheck(root)
  ];
  if (options.launcher) {
    checks.push(
      launcherConfigCheck(root),
      launcherPublicUrlCheck(root),
      await launcherPublicHealthCheck(root),
        launcherGptUrlCheck(root),
        launcherReadinessCheck(root),
        relayPlaceholderCheck(root),
        relayPairingCheck(root)
      );
  }
  const ok = checks.every((item) => item.status !== "FAIL");
  return {
    ok,
    root,
    project_id: projectId,
    checks,
    recommended_next_action: recommendedNextAction(checks)
  };
}

export function setupCodexPlugin(rootInput = process.cwd(), options: SetupOptions = {}): SetupResult {
  const root = resolveProjectRoot(rootInput);
  const checks = [distCheck(root), ...pluginValidationChecks(root), securityOutputPolicyCheck(root)];
  const changedFiles: string[] = [];
  if (!options.dryRun) {
    ensureDir(path.join(root, ".agents", "plugins"));
    ensureDir(path.join(root, "plugins", "codexlink"));
  }
  return {
    ok: checks.every((item) => item.status !== "FAIL"),
    dry_run: Boolean(options.dryRun),
    root,
    checks,
    changed_files: changedFiles,
    next_steps: [
      "Enable the CodexLink plugin from the repo-local marketplace.",
      "Review and trust the SessionStart hook once.",
      "Run node plugins/codexlink/hooks/session_start.mjs --dry-run to verify hook detection.",
      "Open a new Codex chat and confirm session_bootstrap appears in shared session."
    ]
  };
}

export function setupCodexLauncher(rootInput = process.cwd(), options: LauncherSetupOptions = {}): SetupResult {
  const result = setupLauncher(rootInput, options);
  const checks: DoctorCheck[] = [
    pass("launcher_config_validation", "Launcher config values validate."),
    ...result.warnings.map((warningText) => warn("launcher_warning", warningText, "Use setup launcher with a stable public URL when ready."))
  ];
  return {
    ok: result.ok,
    dry_run: result.dry_run,
    root: result.root,
    checks,
    changed_files: result.changed_files,
    next_steps: result.next_steps
  };
}

export function setupRelay(rootInput = process.cwd(), options: SetupOptions = {}): SetupResult {
  const root = resolveProjectRoot(rootInput);
  const checks: DoctorCheck[] = [
    warn("relay_mode", RELAY_MODE_WARNING, "Use stable tunnel/domain for production until relay protocol and pairing are implemented."),
    validateRelayProtocolSpec().ok
      ? pass("relay_protocol", "Relay protocol spec validates as spec-only with bounded allowlisted routes.")
      : fail("relay_protocol", "Relay protocol spec validation failed.", "Fix relay protocol before continuing."),
    pass("relay_security_guardrails", "Relay setup placeholder adds no command runner, no file write capability, and no OpenAI API key requirement."),
    pass("relay_docs", "Relay roadmap is documented for future implementation.")
  ];
  const changedFiles: string[] = [];
  const relayConfig = bridgePath(root, "relay-config.json");
  if (!options.dryRun) {
    ensureDir(getBridgeDir(root));
    writeText(
      relayConfig,
      `${JSON.stringify(
        {
          version: 1,
          enabled: false,
          mode: "planned",
          relay_url: null,
          pairing: "not_implemented",
          note: "Relay mode is a local placeholder. Production relay is not implemented yet."
        },
        null,
        2
      )}\n`
    );
    changedFiles.push(".agentbridge/relay-config.json");
  }
  return {
    ok: true,
    dry_run: Boolean(options.dryRun),
    root,
    checks,
    changed_files: changedFiles,
    next_steps: [
      "Use a stable public HTTPS endpoint today: setup launcher --public-url <url>.",
      "Read docs/architecture/CODEXLINK_V1_2_ZERO_SETUP_ROADMAP.md before implementing relay.",
      "Do not expose shell, write-file, local auth token, or raw file content through relay.",
      "Prototype self-host relay before any hosted production relay."
    ]
  };
}

export function setupGptActions(rootInput = process.cwd(), options: SetupOptions = {}): SetupResult {
  const root = resolveProjectRoot(rootInput);
  const checks: DoctorCheck[] = [];
  const changedFiles: string[] = [];
  const localHost = options.host ?? "127.0.0.1";
  const localPort = options.port ?? 7777;
  const localUrl = `http://${localHost}:${localPort}`;
  const generator = path.join(root, "scripts", "generate-openapi.mjs");
  if (!pathExists(generator)) {
    checks.push(fail("openapi_generator", "scripts/generate-openapi.mjs is missing.", "Restore the OpenAPI generator."));
  } else if (options.dryRun) {
    checks.push(pass("openapi_generator", "OpenAPI generator exists; dry-run did not execute it."));
  } else {
    const result = spawnSync(process.execPath, [generator], {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true
    });
    checks.push(
      result.status === 0
        ? pass("openapi_generator", "OpenAPI schemas regenerated.")
        : fail("openapi_generator", `OpenAPI generation failed: ${shortError(result.stderr || result.stdout)}`, "Run npm run generate:openapi.")
    );
  }

  checks.push(...openApiChecks(root));
  const remote = readJsonIfExists<{ public_url?: string; url?: string }>(bridgePath(root, "remote_bridge.json"));
  const launcher = readLauncherConfig(root);
  const publicUrl = normalizeSetupPublicUrl(options.publicUrl) ?? launcher?.publicBaseUrl ?? remote?.public_url ?? remote?.url ?? "https://YOUR-TUNNEL-URL.example";
  const schemaSource = path.join(root, "openapi.agentbridge.gpt-actions.json");
  const bridgeDir = getBridgeDir(root);
  const liveSchema = bridgePath(root, "openapi-gpt-actions-live.json");
  const setupGuide = bridgePath(root, "GPT_ACTION_SETUP.txt");

  if (!options.dryRun && pathExists(schemaSource)) {
    ensureDir(bridgeDir);
    const schema = fs.readFileSync(schemaSource, "utf8").replace(/https:\/\/YOUR-TUNNEL-URL\.example/g, publicUrl);
    writeText(liveSchema, schema);
    writeText(setupGuide, gptActionsGuide(publicUrl, liveSchema, localUrl));
    changedFiles.push(".agentbridge/openapi-gpt-actions-live.json", ".agentbridge/GPT_ACTION_SETUP.txt");
  }

  checks.push(
    publicUrl === "https://YOUR-TUNNEL-URL.example"
      ? warn("gpt_actions_tunnel", "No registered tunnel URL; live schema will keep placeholder.", "Start/register a tunnel before importing into GPT Actions.")
      : isQuickTunnelUrl(publicUrl)
        ? warn("gpt_actions_tunnel", "Quick tunnel URL configured; GPT Actions schema may need update after restart.", "Use a stable tunnel/domain for one-click GPTs usage.")
      : pass("gpt_actions_tunnel", "Registered tunnel URL found for live schema.")
  );
  checks.push(localTokenCheck(root));

  return {
    ok: checks.every((item) => item.status !== "FAIL"),
    dry_run: Boolean(options.dryRun),
    root,
    checks,
    changed_files: changedFiles,
    next_steps: [
      `Start AgentBridge local server at ${localUrl}.`,
      "Start or refresh HTTPS tunnel.",
      "Import .agentbridge/openapi-gpt-actions-live.json into GPT Actions.",
      "Configure Bearer auth without pasting the token into chat.",
      "Run node dist/cli.js doctor after saving GPT Actions."
    ]
  };
}

function normalizeSetupPublicUrl(input: string | undefined): string | undefined {
  if (!input) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("--public-url must be a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("--public-url must use https://.");
  }
  return url.toString().replace(/\/$/, "");
}

function gptActionsGuide(publicUrl: string, liveSchema: string, localUrl: string): string {
  return [
    "CodexLink GPT Actions setup",
    "",
    `Local server: ${localUrl}`,
    `Tunnel URL: ${publicUrl}`,
    `Schema file: ${liveSchema}`,
    "",
    "Authentication:",
    "- Type: API Key",
    "- Auth Type: Bearer",
    "- Paste the local token only in the GPT Actions authentication field.",
    "",
    "Security:",
    "- Do not paste the token into normal chat.",
    "- Quick tunnel URLs are temporary and may need refresh.",
    "- /chatgpt/* endpoints must remain bearer-token protected."
  ].join("\n");
}

export function formatDoctorText(result: DoctorResult): string {
  const lines = [
    "CodexLink Doctor",
    `Project: ${result.project_id}`,
    "",
    "Status  Check                         Message"
  ];
  for (const item of result.checks) {
    lines.push(`${item.status.padEnd(6)} ${item.name.padEnd(29)} ${item.message}`);
  }
  lines.push("", "Recommended next action:", `- ${result.recommended_next_action}`);
  return lines.join("\n");
}

export function formatSetupText(title: string, result: SetupResult): string {
  const lines = [
    title,
    `Mode: ${result.dry_run ? "dry-run" : "write"}`,
    "",
    "Status  Check                         Message"
  ];
  for (const item of result.checks) {
    lines.push(`${item.status.padEnd(6)} ${item.name.padEnd(29)} ${item.message}`);
  }
  lines.push("", "Next steps:", ...result.next_steps.map((step) => `- ${step}`));
  if (result.changed_files.length) {
    lines.push("", "Changed files:", ...result.changed_files.map((file) => `- ${file}`));
  }
  return lines.join("\n");
}

export function diagnoseSetupIssue(code: string, detail?: string): string {
  switch (code) {
    case "ClientResponseError":
      return "ClientResponseError from GPT Actions/client. Check tunnel URL, bearer auth, and whether AgentBridge is running.";
    case "server_not_running":
      return "AgentBridge local server is not running.";
    case "project_not_registered":
      return `Project is not registered or cannot be resolved${detail ? `: ${detail}` : "."}`;
    case "mcp_plugin_missing":
      return "CodexLink MCP/plugin files are missing or not enabled.";
    case "schema_missing_request_body":
      return "GPT Actions schema is missing explicit requestBody properties.";
    case "local_token_missing":
      return "Local auth token file is missing. Value was not read or printed.";
    case "hook_not_trusted":
      return "Codex SessionStart hook needs user review/trust before it can run automatically.";
    case "tunnel_fetch_error":
      return `Tunnel health check failed${detail ? `: ${detail}` : "."}`;
    default:
      return detail ? `${code}: ${detail}` : code;
  }
}

export function diagnoseHttpStatus(status: number): string {
  if (status === 502) {
    return "Tunnel returned HTTP 502. Local AgentBridge server may be down or unreachable from the tunnel.";
  }
  if (status === 530) {
    return "Tunnel returned HTTP 530. Cloudflare quick tunnel is likely stale or unavailable.";
  }
  if (status === 401) {
    return "Endpoint returned HTTP 401. Bearer auth is missing or invalid.";
  }
  return `Tunnel health returned HTTP ${status}.`;
}

function recommendedNextAction(checks: DoctorCheck[]): string {
  const firstFail = checks.find((item) => item.status === "FAIL");
  if (firstFail) {
    return firstFail.next_step;
  }
  const firstWarn = checks.find((item) => item.status === "WARN");
  if (firstWarn) {
    return firstWarn.next_step;
  }
  return "Setup looks healthy. Open Codex, enable CodexLink, trust the hook, then test GPT Actions.";
}

function shortError(error: unknown): string {
  return String(error instanceof Error ? error.message : error ?? "").replace(/\s+/g, " ").slice(0, 400);
}

function containsSecretLikeText(input: string): boolean {
  return (
    /Bearer\s+(?!\[REDACTED\])\S{12,}/i.test(input) ||
    /OPENAI_API_KEY\s*=\s*sk-/i.test(input) ||
    /\bsk-[A-Za-z0-9_-]{20,}\b/.test(input) ||
    /\.agentbridge[\\/]local_token/i.test(input)
  );
}

function scanRuntimeFiles(root: string, filePattern: RegExp, contentPattern: RegExp, maxFiles: number): string[] {
  const matches: string[] = [];
  let checked = 0;
  const walk = (directory: string): void => {
    if (checked >= maxFiles || matches.length) {
      return;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (checked >= maxFiles || matches.length) {
        return;
      }
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!filePattern.test(entry.name)) {
        continue;
      }
      checked += 1;
      const content = fs.readFileSync(fullPath, "utf8");
      if (contentPattern.test(content)) {
        matches.push(fullPath);
      }
    }
  };
  try {
    walk(root);
  } catch {
    return [];
  }
  return matches;
}
