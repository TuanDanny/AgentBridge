import { readJsonIfExists } from "./fsx.js";
import { requestJson } from "./httpJson.js";
import { bridgePath, resolveProjectRoot } from "./paths.js";
import { readLocalToken } from "./auth.js";
import type { ServerInfo } from "./types.js";

export interface ServerProbe {
  running: boolean;
  info?: ServerInfo;
  health?: unknown;
  error?: string;
}

export function readServerInfo(rootInput = process.cwd()): ServerInfo | undefined {
  const root = resolveProjectRoot(rootInput);
  return readJsonIfExists<ServerInfo>(bridgePath(root, "server.json"));
}

export async function probeServer(rootInput = process.cwd()): Promise<ServerProbe> {
  const root = resolveProjectRoot(rootInput);
  const info = readServerInfo(root);
  if (!info) {
    return { running: false, error: "No .agentbridge/server.json found." };
  }

  try {
    const health = await requestJson({
      host: info.host,
      port: info.port,
      path: "/health",
      timeoutMs: 1000
    });
    return { running: health.status >= 200 && health.status < 300, info, health: health.body };
  } catch (error) {
    return {
      running: false,
      info,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function stopServer(rootInput = process.cwd()): Promise<string> {
  const root = resolveProjectRoot(rootInput);
  const info = readServerInfo(root);
  if (!info) {
    return "AgentBridge daemon is not running: server.json not found.";
  }

  const token = readLocalToken(root);
  if (!token) {
    return "AgentBridge daemon cannot be stopped: local token not found.";
  }

  const response = await requestJson({
    host: info.host,
    port: info.port,
    path: "/shutdown",
    method: "POST",
    token,
    timeoutMs: 2000
  });

  if (response.status >= 200 && response.status < 300) {
    return `AgentBridge daemon stop requested for ${info.host}:${info.port}.`;
  }

  return `AgentBridge daemon stop failed with HTTP ${response.status}.`;
}
