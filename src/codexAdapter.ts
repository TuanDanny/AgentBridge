import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import { bridgePath, resolveProjectRoot } from "./paths.js";
import { pathExists, readTextIfExists } from "./fsx.js";
import { createCodexPrompt } from "./core.js";

export interface CodexHandoff {
  promptPath: string;
  prompt: string;
}

export interface CodexRunOptions {
  codexCommand?: string;
  dryRun?: boolean;
}

export function loadCodexHandoff(rootInput = process.cwd()): CodexHandoff {
  const root = resolveProjectRoot(rootInput);
  const promptPath = bridgePath(root, "codex_prompt.md");
  if (!pathExists(promptPath)) {
    createCodexPrompt(root);
  }

  return {
    promptPath,
    prompt: readTextIfExists(promptPath)
  };
}

export function copyPromptToClipboard(prompt: string): void {
  if (process.platform === "win32") {
    const result = spawnSync("clip", {
      input: prompt,
      encoding: "utf8",
      windowsHide: true
    });
    if (result.error || result.status !== 0) {
      throw result.error ?? new Error("Failed to copy prompt with clip.");
    }
    return;
  }

  if (process.platform === "darwin") {
    const result = spawnSync("pbcopy", {
      input: prompt,
      encoding: "utf8"
    });
    if (result.error || result.status !== 0) {
      throw result.error ?? new Error("Failed to copy prompt with pbcopy.");
    }
    return;
  }

  for (const command of ["wl-copy", "xclip"]) {
    const args = command === "xclip" ? ["-selection", "clipboard"] : [];
    const result = spawnSync(command, args, {
      input: prompt,
      encoding: "utf8"
    });
    if (!result.error && result.status === 0) {
      return;
    }
  }

  throw new Error("No supported clipboard command found.");
}

export function openPromptFile(promptPath: string): void {
  const opener =
    process.platform === "win32"
      ? { command: "cmd", args: ["/c", "start", "", promptPath] }
      : process.platform === "darwin"
        ? { command: "open", args: [promptPath] }
        : { command: "xdg-open", args: [promptPath] };

  const child = spawn(opener.command, opener.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

export function buildCodexRunCommand(prompt: string, options: CodexRunOptions = {}): { command: string; args: string[] } {
  const command = options.codexCommand ?? process.env.AGENTBRIDGE_CODEX_COMMAND ?? "codex";
  const envArgs = process.env.AGENTBRIDGE_CODEX_ARGS?.trim();
  const args = envArgs ? splitArgs(envArgs) : ["exec", prompt];
  return { command, args };
}

export function runCodexPrompt(prompt: string, options: CodexRunOptions = {}): Promise<{ command: string; args: string[]; dryRun: boolean }> {
  const commandSpec = buildCodexRunCommand(prompt, options);
  if (options.dryRun) {
    return Promise.resolve({ ...commandSpec, dryRun: true });
  }

  return new Promise((resolve, reject) => {
    const child = spawn(commandSpec.command, commandSpec.args, {
      stdio: "inherit",
      shell: false,
      windowsHide: false
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ ...commandSpec, dryRun: false });
        return;
      }
      reject(new Error(`Codex exited with code ${code ?? "unknown"}.`));
    });
  });
}

function splitArgs(value: string): string[] {
  return value
    .match(/(?:[^\s"]+|"[^"]*")+/g)
    ?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
}

export function describeCodexEnvironment(): string {
  return `platform=${process.platform} arch=${process.arch} home=${os.homedir()}`;
}
