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
  relayHost: string;
  relayPort: number;
  autoRelay: boolean;
  relayUrl?: string;
  autoRelayClient: boolean;
  relayDeviceId?: string;
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
  relayHost?: string;
  relayPort?: number;
  autoRelay?: boolean;
  relayUrl?: string;
  autoRelayClient?: boolean;
  relayDeviceId?: string;
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
  "Relay mode uses a hosted MVP relay. Use only a trusted relay URL; pairing is short-lived and relay forwarding stays metadata/inspector only.";

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
    tunnelMode: "stable",
    relayHost: "127.0.0.1",
    relayPort: 8787,
    autoRelay: true,
    autoRelayClient: true
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
  const relayHost = validateRelayHost(input.relayHost ?? defaults.relayHost);
  const relayPort = validatePort(input.relayPort ?? defaults.relayPort, "Launcher relayPort");
  const relayUrl = validateOptionalRelayUrl(input.relayUrl, "relayUrl");
  const config: LauncherConfig = {
    projectId,
    host,
    port,
    openBrowser: input.openBrowser ?? defaults.openBrowser,
    copyGreetingToClipboard: input.copyGreetingToClipboard ?? defaults.copyGreetingToClipboard,
    autoBootstrap: input.autoBootstrap ?? defaults.autoBootstrap,
    autoDoctor: input.autoDoctor ?? defaults.autoDoctor,
    tunnelMode,
    relayHost,
    relayPort,
    autoRelay: input.autoRelay ?? defaults.autoRelay,
    autoRelayClient: input.autoRelayClient ?? defaults.autoRelayClient
  };
  if (publicBaseUrl) {
    config.publicBaseUrl = publicBaseUrl;
  }
  if (gptUrl) {
    config.gptUrl = gptUrl;
  }
  if (relayUrl) {
    config.relayUrl = relayUrl;
  }
  if (input.relayDeviceId?.trim()) {
    config.relayDeviceId = input.relayDeviceId.trim();
  }
  warnings.push(...launcherWarnings(config));
  return { config, warnings };
}

export function launcherWarnings(config: LauncherConfig): string[] {
  const warnings: string[] = [];
  if (config.tunnelMode === "relay" && config.relayUrl) {
    if (isQuickTunnelUrl(config.relayUrl)) {
      warnings.push(QUICK_TUNNEL_WARNING);
    }
  } else if (!config.publicBaseUrl) {
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
    tunnelMode: options.tunnelMode ?? existing.tunnelMode,
    relayHost: options.relayHost ?? existing.relayHost,
    relayPort: options.relayPort ?? existing.relayPort,
    autoRelay: options.autoRelay ?? existing.autoRelay,
    relayUrl: options.relayUrl ?? existing.relayUrl,
    autoRelayClient: options.autoRelayClient ?? existing.autoRelayClient,
    relayDeviceId: options.relayDeviceId ?? existing.relayDeviceId
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
      config.relayUrl
        ? `The launcher can auto-start the hosted relay client for ${config.relayUrl}.`
        : `The launcher can auto-start the loopback relay prototype at http://${config.relayHost}:${config.relayPort}.`,
      "Pair GPT Actions with the short-lived code printed by the relay client.",
      "Use a trusted stable relay origin for true zero-setup daily use."
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

function validatePort(port: number, label = "Launcher port"): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535.`);
  }
  return port;
}

function validateRelayHost(host: string): string {
  const trimmed = validateHost(host);
  if (trimmed !== "127.0.0.1" && trimmed !== "localhost" && trimmed !== "::1") {
    throw new Error("Launcher relayHost must be loopback: 127.0.0.1, localhost, or ::1.");
  }
  return trimmed;
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

function validateOptionalRelayUrl(value: string | undefined, field: string): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const url = parseUrl(value, field);
  const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "https:" && url.protocol !== "wss:" && !(isLoopback && (url.protocol === "http:" || url.protocol === "ws:"))) {
    throw new Error(`${field} must use https:// or wss://, except loopback test URLs may use http:// or ws://.`);
  }
  url.protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
  return url.toString().replace(/\/$/, "");
}

function parseUrl(value: string, field: string): URL {
  try {
    return new URL(value.trim());
  } catch {
    throw new Error(`${field} must be a valid URL.`);
  }
}
