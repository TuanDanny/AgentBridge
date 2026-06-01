#!/usr/bin/env node
import { Command } from "commander";
import {
  captureProject,
  createChatGptReview,
  createCodexPrompt,
  getStatus,
  initProject,
  prepareCodexResult
} from "./core.js";
import {
  copyPromptToClipboard,
  describeCodexEnvironment,
  loadCodexHandoff,
  openPromptFile,
  runCodexPrompt
} from "./codexAdapter.js";
import { probeServer, stopServer } from "./daemonClient.js";
import {
  applyGroupDecision,
  createGroupBrief,
  createGroupDecisionTemplate,
  createGroupHandoff,
  getGroupStatus
} from "./group.js";
import { classifyCommand, createApproval, listApprovals, resolveApproval } from "./safety.js";
import { startAgentBridgeServer } from "./server.js";
import type { ApprovalStatus, RiskLevel } from "./types.js";
import { addProject, listProjects, registryPath, removeProject } from "./registry.js";
import { createPairingInfo } from "./pairing.js";

function printResult(result: { message: string; bridgeDir: string; changedFiles: string[] }): void {
  console.log(result.message);
  console.log(`Bridge dir: ${result.bridgeDir}`);
  if (result.changedFiles.length) {
    console.log(`Updated: ${result.changedFiles.join(", ")}`);
  }
}

function handleError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`agentbridge: ${message}`);
  process.exit(1);
}

const program = new Command();

program
  .name("agentbridge")
  .description("Local shared-session bridge for ChatGPT and Codex.")
  .version("0.1.0");

program
  .command("init")
  .description("Create .agentbridge shared-session files in the current project.")
  .action(() => {
    try {
      printResult(initProject());
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("capture")
  .description("Capture git status and diff into .agentbridge/project_context.md.")
  .option("--mode <mode>", "capture mode: short, full, or raw", "short")
  .action((options: { mode: string }) => {
    try {
      printResult(captureProject(process.cwd(), options.mode));
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("prompt")
  .description("Create .agentbridge/codex_prompt.md from intent, context, and plan.")
  .action(() => {
    try {
      printResult(createCodexPrompt());
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("result")
  .description("Create a Codex result template if one does not already exist.")
  .action(() => {
    try {
      printResult(prepareCodexResult());
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("review")
  .description("Create .agentbridge/chatgpt_review.md for ChatGPT review.")
  .action(() => {
    try {
      printResult(createChatGptReview());
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("start")
  .description("Start the local AgentBridge HTTP daemon in the foreground.")
  .option("--host <host>", "host to bind", "127.0.0.1")
  .option("--port <port>", "port to bind", "7777")
  .action(async (options: { host: string; port: string }) => {
    try {
      const port = Number.parseInt(options.port, 10);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error("Port must be an integer from 0 to 65535.");
      }

      const running = await startAgentBridgeServer(process.cwd(), {
        host: options.host,
        port
      });
      console.log(`AgentBridge daemon listening on http://${running.info.host}:${running.info.port}`);
      console.log(`Bridge dir: ${running.info.bridge_dir}`);
      console.log("Press Ctrl+C to stop, or run `agentbridge stop` from another terminal.");
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("stop")
  .description("Request shutdown for the local AgentBridge HTTP daemon.")
  .action(async () => {
    try {
      console.log(await stopServer());
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("mcp")
  .description("Run the AgentBridge MCP server over stdio.")
  .action(async () => {
    try {
      const { runMcpStdioServer } = await import("./mcpServer.js");
      await runMcpStdioServer();
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("codex")
  .description("Hand the current AgentBridge prompt to Codex.")
  .option("--copy", "copy .agentbridge/codex_prompt.md to clipboard")
  .option("--open", "open .agentbridge/codex_prompt.md with the OS default app")
  .option("--run", "run Codex CLI explicitly with the generated prompt")
  .option("--dry-run", "print the Codex CLI command without running it")
  .option("--codex-command <command>", "Codex executable to use for --run", "codex")
  .action(async (options: { copy?: boolean; open?: boolean; run?: boolean; dryRun?: boolean; codexCommand: string }) => {
    try {
      const handoff = loadCodexHandoff();
      const shouldCopy = options.copy || (!options.open && !options.run);

      if (shouldCopy) {
        copyPromptToClipboard(handoff.prompt);
        console.log(`Copied Codex prompt to clipboard: ${handoff.promptPath}`);
      }

      if (options.open) {
        openPromptFile(handoff.promptPath);
        console.log(`Opened Codex prompt: ${handoff.promptPath}`);
      }

      if (options.run) {
        const result = await runCodexPrompt(handoff.prompt, {
          codexCommand: options.codexCommand,
          dryRun: options.dryRun
        });
        console.log(
          options.dryRun
            ? `Dry run: ${result.command} ${result.args.map((arg) => JSON.stringify(arg)).join(" ")}`
            : `Codex command finished: ${result.command}`
        );
      }

      if (options.dryRun && !options.run) {
        console.log(`Codex environment: ${describeCodexEnvironment()}`);
      }
    } catch (error) {
      handleError(error);
    }
  });

const safety = program.command("safety").description("Inspect AgentBridge safety decisions.");

safety
  .command("classify")
  .description("Classify command risk without running the command.")
  .argument("<command...>", "command to classify")
  .action((commandParts: string[]) => {
    const command = commandParts.join(" ");
    console.log(JSON.stringify(classifyCommand(command), null, 2));
  });

const group = program.command("group").description("Create safe group-chat coordination files.");

group
  .command("brief")
  .description("Create .agentbridge/group_brief.md for ChatGPT group chat coordination.")
  .action(() => {
    try {
      printResult(createGroupBrief());
    } catch (error) {
      handleError(error);
    }
  });

group
  .command("handoff")
  .description("Create .agentbridge/group_handoff.md for group review of Codex results.")
  .action(() => {
    try {
      printResult(createGroupHandoff());
    } catch (error) {
      handleError(error);
    }
  });

group
  .command("decision-template")
  .description("Create .agentbridge/group_decision.md for a group decision.")
  .action(() => {
    try {
      printResult(createGroupDecisionTemplate());
    } catch (error) {
      handleError(error);
    }
  });

group
  .command("apply-decision")
  .description("Apply .agentbridge/group_decision.md to the shared AgentBridge plan and Codex prompt.")
  .action(() => {
    try {
      printResult(applyGroupDecision());
    } catch (error) {
      handleError(error);
    }
  });

group
  .command("status")
  .description("Print group companion file status and next recommended step.")
  .action(() => {
    try {
      console.log(getGroupStatus());
    } catch (error) {
      handleError(error);
    }
  });

const approvals = program.command("approvals").description("Manage local approval requests.");

approvals
  .command("list")
  .description("List approval requests.")
  .option("--status <status>", "pending, approved, rejected, or expired")
  .action((options: { status?: ApprovalStatus }) => {
    const status = options.status;
    if (status && !["pending", "approved", "rejected", "expired"].includes(status)) {
      handleError(new Error("Invalid approval status."));
    }
    console.log(JSON.stringify(listApprovals(process.cwd(), status), null, 2));
  });

approvals
  .command("request")
  .description("Create a pending approval request.")
  .requiredOption("--action <action>", "action requiring approval")
  .option("--actor <actor>", "actor requesting approval", "codex")
  .option("--command <command>", "command requiring approval")
  .option("--reason <reason>", "reason for the request")
  .option("--risk <risk>", "low, medium, or high")
  .action((options: { action: string; actor: string; command?: string; reason?: string; risk?: RiskLevel }) => {
    if (options.risk && !["low", "medium", "high"].includes(options.risk)) {
      handleError(new Error("Invalid approval risk."));
    }
    console.log(JSON.stringify(createApproval(process.cwd(), options), null, 2));
  });

approvals
  .command("approve")
  .description("Mark an approval request as approved.")
  .argument("<id>", "approval id")
  .action((id: string) => {
    try {
      console.log(JSON.stringify(resolveApproval(process.cwd(), id, "approved"), null, 2));
    } catch (error) {
      handleError(error);
    }
  });

approvals
  .command("reject")
  .description("Mark an approval request as rejected.")
  .argument("<id>", "approval id")
  .action((id: string) => {
    try {
      console.log(JSON.stringify(resolveApproval(process.cwd(), id, "rejected"), null, 2));
    } catch (error) {
      handleError(error);
    }
  });

const projects = program.command("projects").description("Manage the AgentBridge multi-project registry.");

projects
  .command("list")
  .description("List registered projects.")
  .action(() => {
    console.log(JSON.stringify({ registry: registryPath(), projects: listProjects() }, null, 2));
  });

projects
  .command("add")
  .description("Register a project in the global AgentBridge registry.")
  .argument("[path]", "project path", process.cwd())
  .action((projectPath: string) => {
    try {
      console.log(JSON.stringify(addProject(projectPath), null, 2));
    } catch (error) {
      handleError(error);
    }
  });

projects
  .command("remove")
  .description("Remove a project from the global AgentBridge registry.")
  .argument("<path>", "project path")
  .action((projectPath: string) => {
    console.log(JSON.stringify({ removed: removeProject(projectPath), registry: registryPath() }, null, 2));
  });

program
  .command("pair")
  .description("Print a local dashboard pairing URL, optionally as an ASCII QR code.")
  .option("--host <host>", "host to show in the URL")
  .option("--port <port>", "port to show in the URL")
  .option("--qr", "print an ASCII QR code")
  .action((options: { host?: string; port?: string; qr?: boolean }) => {
    let port: number | undefined;
    if (options.port !== undefined) {
      const parsedPort = Number.parseInt(options.port, 10);
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        handleError(new Error("Port must be an integer from 1 to 65535."));
      }
      port = parsedPort;
    }
    const pairing = createPairingInfo(process.cwd(), {
      host: options.host,
      port,
      qr: options.qr
    });
    console.log(`Dashboard: ${pairing.dashboardUrl}`);
    if (pairing.warning) {
      console.log(`Warning: ${pairing.warning}`);
    }
    if (pairing.qr) {
      console.log(pairing.qr);
    }
  });

program
  .command("status")
  .description("Print the current AgentBridge session and daemon status.")
  .action(async () => {
    try {
      console.log(getStatus());
      const server = await probeServer();
      if (server.running && server.info) {
        console.log(`Daemon: running at http://${server.info.host}:${server.info.port} (pid ${server.info.pid})`);
      } else {
        console.log(`Daemon: not running${server.error ? ` (${server.error})` : ""}`);
      }
    } catch (error) {
      handleError(error);
    }
  });

await program.parseAsync();
