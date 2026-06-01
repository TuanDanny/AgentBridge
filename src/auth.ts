import crypto from "node:crypto";
import { readTextIfExists, writeTextIfMissing } from "./fsx.js";
import { bridgePath } from "./paths.js";

export function ensureLocalToken(root: string): string {
  const filePath = bridgePath(root, "local_token");
  writeTextIfMissing(filePath, `${crypto.randomBytes(32).toString("hex")}\n`);
  return readLocalToken(root);
}

export function readLocalToken(root: string): string {
  return readTextIfExists(bridgePath(root, "local_token")).trim();
}

export function isAuthorized(headers: Record<string, string | string[] | undefined>, token: string): boolean {
  const headerToken = headers["x-agentbridge-token"];
  if (typeof headerToken === "string" && headerToken === token) {
    return true;
  }

  const authorization = headers.authorization;
  if (typeof authorization === "string" && authorization === `Bearer ${token}`) {
    return true;
  }

  return false;
}
