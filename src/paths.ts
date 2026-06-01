import path from "node:path";
import { BRIDGE_DIR } from "./types.js";

export function resolveProjectRoot(root = process.cwd()): string {
  return path.resolve(root);
}

export function getBridgeDir(root: string): string {
  return path.join(root, BRIDGE_DIR);
}

export function bridgePath(root: string, name: string): string {
  return path.join(getBridgeDir(root), name);
}

export function getProjectName(root: string): string {
  return path.basename(root) || "project";
}
