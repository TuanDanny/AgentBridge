import fs from "node:fs";
import path from "node:path";

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function pathExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function readTextIfExists(filePath: string, fallback = ""): string {
  if (!pathExists(filePath)) {
    return fallback;
  }

  return fs.readFileSync(filePath, "utf8");
}

export function writeText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
}

export function appendText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, content, "utf8");
}

export function writeTextIfMissing(filePath: string, content: string): boolean {
  if (pathExists(filePath)) {
    return false;
  }

  writeText(filePath, content);
  return true;
}

export function readJsonIfExists<T>(filePath: string): T | undefined {
  if (!pathExists(filePath)) {
    return undefined;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function writeJson(filePath: string, value: unknown): void {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function appendJsonLine(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}
