import { bridgePath, getBridgeDir, resolveProjectRoot } from "./paths.js";
import { ensureDir, pathExists, readJsonIfExists, writeJson } from "./fsx.js";
import { validateProjectId } from "./registry.js";

export type LauncherTunnelMode = "none" | "quick" | "stable" | "external" | "relay";

export interface LauncherConfig {
  projectId: string;
  host: string;
  port: number;
  publicBaseUrl?: string;
  gptUrl?: string;
  openBrowser: boolean;
  copyGreetingToClipboard: boolean;
  autoBootstrap: boolean;
  autoDoctor: boolean;
  tunnelMode: LauncherTunnelMode;
}

export interface LauncherSetupOptions {
  dryRun?: boolean;
  projectId?: string;
  host?: string;
  port?: number;
  publicBaseUrl?: string;
  gptUrl?: string;
  openBrowser?: boolean;
  copyGreetingToClipboard?: boolean;
  autoBootstrap?: boolean;
  autoDoctor?: boolean;
  tunnelMode?: LauncherTunnelMode;
}

export interface LauncherValidationResult {
  config: LauncherConfig;
  warnings: string[];
}

export interface LauncherSetupResult {
  ok: boolean;
  dry_run: boolean;
  root: string;
  config_path: string;
  config: LauncherConfig;
  warnings: string[];
  changed_files: string[];
  greeting: string;
  next_steps: string[];
}

export const QUICK_TUNNEL_WARNING =
  "Quick Tunnel URL is temporary. GPT Actions may need schema update after restart. Use a stable tunnel/domain for one-click GPTs usage.";
export const RELAY_MODE_WARNING =
  "Relay mode is experimental. The launcher can prepare local pairing metadata and the relay GPT Actions schema, but a hosted stable relay is not production-ready yet.";

export function launcherConfigPath(rootInput = process.cwd()): string {
  return bridgePath(resolveProjectRoot(rootInput), "launcher-config.json");
}

export function defaultLauncherConfig(rootInput = process.cwd()): LauncherConfig {
  const root = resolveProjectRoot(rootInput);
  return {
    projectId: validateProjectId(root.split(/[\\/]+/).filter(Boolean).at(-1) ?? "AgentBridge"),
    host: "127.0.0.1",
    port: 7777,
    openBrowser: true,
    copyGreetingToClipboard: true,
    autoBootstrap: true,
    autoDoctor: true,
    tunnelMode: "stable"
  };
}

export function readLauncherConfig(rootInput = process.cwd()): LauncherConfig | undefined {
  const raw = readJsonIfExists<Partial<LauncherConfig>>(launcherConfigPath(rootInput));
  if (!raw) {
    return undefined;
  }
  return validateLauncherConfig(rootInput, raw).config;
}

export function validateLauncherConfig(rootInput: string, input: Partial<LauncherConfig>): LauncherValidationResult {
  const defaults = defaultLauncherConfig(rootInput);
  const warnings: string[] = [];
  const projectId = validateProjectId(input.projectId ?? defaults.projectId);
  const host = validateHost(input.host ?? defaults.host);
  const port = validatePort(input.port ?? defaults.port);
  const publicBaseUrl = validateOptionalHttpsUrl(input.publicBaseUrl, "publicBaseUrl");
  const gptUrl = validateOptionalHttpUrl(input.gptUrl, "gptUrl");
  const tunnelMode = validateTunnelMode(input.tunnelMode ?? inferTunnelMode(publicBaseUrl, defaults.tunnelMode));
  const config: LauncherConfig = {
    projectId,
    host,
    port,
    openBrowser: input.openBrowser ?? defaults.openBrowser,
    copyGreetingToClipboard: input.copyGreetingToClipboard ?? defaults.copyGreetingToClipboard,
    autoBootstrap: input.autoBootstrap ?? defaults.autoBootstrap,
    autoDoctor: input.autoDoctor ?? defaults.autoDoctor,
    tunnelMode
  };
  if (publicBaseUrl) {
    config.publicBaseUrl = publicBaseUrl;
  }
  if (gptUrl) {
    config.gptUrl = gptUrl;
  }
  warnings.push(...launcherWarnings(config));
  return { config, warnings };
}

export function launcherWarnings(config: LauncherConfig): string[] {
  const warnings: string[] = [];
  if (!config.publicBaseUrl) {
    warnings.push(
      config.tunnelMode === "relay"
        ? RELAY_MODE_WARNING
        : "No publicBaseUrl configured. Local server can start, but GPT Actions need a public HTTPS endpoint."
    );
  } else if (isQuickTunnelUrl(config.publicBaseUrl)) {
    warnings.push(QUICK_TUNNEL_WARNING);
  } else if (config.tunnelMode === "relay") {
    warnings.push(RELAY_MODE_WARNING);
  }
  return warnings;
}

export function setupLauncher(rootInput = process.cwd(), options: LauncherSetupOptions = {}): LauncherSetupResult {
  const root = resolveProjectRoot(rootInput);
  const existing = readJsonIfExists<Partial<LauncherConfig>>(launcherConfigPath(root)) ?? {};
  const { config, warnings } = validateLauncherConfig(root, {
    ...existing,
    projectId: options.projectId ?? existing.projectId,
    host: options.host ?? existing.host,
    port: options.port ?? existing.port,
    publicBaseUrl: options.publicBaseUrl ?? existing.publicBaseUrl,
    gptUrl: options.gptUrl ?? existing.gptUrl,
    openBrowser: options.openBrowser ?? existing.openBrowser,
    copyGreetingToClipboard: options.copyGreetingToClipboard ?? existing.copyGreetingToClipboard,
    autoBootstrap: options.autoBootstrap ?? existing.autoBootstrap,
    autoDoctor: options.autoDoctor ?? existing.autoDoctor,
    tunnelMode: options.tunnelMode ?? existing.tunnelMode
  });
  const changedFiles: string[] = [];
  const configPath = launcherConfigPath(root);
  if (!options.dryRun) {
    ensureDir(getBridgeDir(root));
    writeJson(configPath, config);
    changedFiles.push(".agentbridge/launcher-config.json");
  }
  return {
    ok: true,
    dry_run: Boolean(options.dryRun),
    root,
    config_path: configPath,
    config,
    warnings,
    changed_files: changedFiles,
    greeting: createLauncherGreeting(),
    next_steps: launcherNextSteps(config)
  };
}

export function createLauncherGreeting(): string {
  return [
    "Xin chao CodexLink.",
    "",
    "Hay goi listProjects, chon project mac dinh neu co, roi goi getSessionSummary hoac getSessionContext cho project do.",
    "",
    "Sau do cho toi biet:",
    "- project dang active",
    "- session_id/revision",
    "- current_goal",
    "- phase/status",
    "- recent_activity",
    "- workspace snapshot/gaps neu co",
    "- recommended_next_action",
    "",
    "Khong doc repo neu chua can."
  ].join("\n");
}

function launcherNextSteps(config: LauncherConfig): string[] {
  const base = [
    "Run npm install if dependencies are missing.",
    "Run npm run build before first use.",
    "Double click start-codexlink.bat for daily use.",
    "Paste the copied greeting into the configured GPT."
  ];
  if (config.tunnelMode === "relay") {
    return [
      ...base,
      "Import openapi.codexlink.relay.gpt-actions.json only when using a trusted relay origin.",
      "Use node dist/cli.js relay pairing create to create a short-lived pairing code.",
      "For local prototype testing only, run node dist/cli.js relay serve --experimental.",
      "Use a stable public URL/domain until a production relay is available."
    ];
  }
  return [...base, "Use a stable public URL/domain for reliable GPT Actions."];
}
export function isQuickTunnelUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith(".trycloudflare.com");
  } catch {
    return false;
  }
}

export function hasLauncherConfig(rootInput = process.cwd()): boolean {
  return pathExists(launcherConfigPath(rootInput));
}

function inferTunnelMode(publicBaseUrl: string | undefined, fallback: LauncherTunnelMode): LauncherTunnelMode {
  if (!publicBaseUrl) {
    return "none";
  }
  return isQuickTunnelUrl(publicBaseUrl) ? "quick" : fallback;
}

function validateHost(host: string): string {
  const trimmed = host.trim();
  if (!trimmed) {
    throw new Error("Launcher host is required.");
  }
  return trimmed;
}

function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Launcher port must be an integer from 1 to 65535.");
  }
  return port;
}

function validateTunnelMode(mode: string): LauncherTunnelMode {
  if (mode === "none" || mode === "quick" || mode === "stable" || mode === "external" || mode === "relay") {
    return mode;
  }
  throw new Error("Launcher tunnelMode must be one of none, quick, stable, external, relay.");
}

function validateOptionalHttpsUrl(value: string | undefined, field: string): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const url = parseUrl(value, field);
  if (url.protocol !== "https:") {
    throw new Error(`${field} must use https://.`);
  }
  return url.toString().replace(/\/$/, "");
}

function validateOptionalHttpUrl(value: string | undefined, field: string): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const url = parseUrl(value, field);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${field} must use http:// or https://.`);
  }
  return url.toString().replace(/\/$/, "");
}

function parseUrl(value: string, field: string): URL {
  try {
    return new URL(value.trim());
  } catch {
    throw new Error(`${field} must be a valid URL.`);
  }
}
