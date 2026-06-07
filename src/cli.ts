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
import {
  addProject,
  findProject,
  formatProjectList,
  listProjects,
  projectIdFromRoot,
  registerCurrentProject,
  registerProject,
  registryPath,
  removeProject
} from "./registry.js";
import { createPairingInfo } from "./pairing.js";
import { formatTunnelTestResult, registerTunnel, testTunnel, tunnelGuide, tunnelStatus } from "./tunnel.js";
import {
  discoverProjects,
  formatProjectScanResult,
  normalizeDiscoverOptions,
  parseScanSelection,
  validateScanRoot,
  type ProjectNameStyle,
  type ProjectScanResult
} from "./discovery.js";
import {
  formatProjectFileRead,
  formatProjectFileSearch,
  formatProjectTextSearch,
  formatProjectTree,
  getProjectTree,
  readProjectFile,
  searchProjectFiles,
  searchProjectText
} from "./projectFiles.js";
import { clearActiveProject, readActiveProject, selectActiveProject } from "./activeProject.js";
import { formatDoctorText, formatSetupText, runDoctor, setupCodexPlugin, setupGptActions } from "./setupDoctor.js";
import {
  createCodexChangesSummary,
  createProjectInspectPacket,
  createProjectInspectorSnapshot,
  formatCodexChangesHuman,
  formatInspectorHuman
} from "./inspector.js";
import {
  addSessionHandoff,
  appendSessionActivity,
  appendSessionCheck,
  appendSessionEvidence,
  appendSessionEvent,
  bootstrapSession,
  formatSessionBootstrap,
  formatSessionHandoffs,
  formatSessionSummary,
  formatSessionUpdates,
  getOrCreateActiveSession,
  getRecentChecks,
  getRecentActivity,
  getRecentEvidence,
  getSessionSummary,
  getSessionUpdates,
  listSessionHandoffs,
  setSessionGoal,
  updateSessionHandoff
} from "./sessionStore.js";
import type {
  SessionActor,
  SessionActivityKind,
  SessionActivitySource,
  SessionActivityStatus,
  SessionBootstrapAdapter,
  SessionBootstrapClient,
  SessionBootstrapMode,
  SessionCheckStatus,
  SessionCheckType,
  SessionCurrentStatus,
  AppendSessionEvidenceInput,
  SessionEventType,
  SessionHandoffStatus,
  SessionPhase
} from "./sessionTypes.js";

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
  .command("inspect")
  .description("Inspect the current project for ChatGPT-readable status.")
  .option("--json", "print the full JSON inspector snapshot")
  .option("--for-chatgpt", "write .agentbridge/project_inspect_packet.md")
  .option("--changes", "focus on changed files and Codex progress/result")
  .option("--project <projectId>", "deprecated; use `agentbridge project inspect <id>`")
  .action((options: { json?: boolean; forChatgpt?: boolean; changes?: boolean; project?: string }) => {
    try {
      if (options.project) {
        console.error("agentbridge: use `agentbridge project inspect <id>` for registered projects; inspecting current project.");
      }

      if (options.forChatgpt) {
        const packet = createProjectInspectPacket(process.cwd());
        console.log(`Created ChatGPT inspect packet: ${packet.path}`);
        return;
      }

      if (options.changes) {
        const changes = createCodexChangesSummary(process.cwd());
        console.log(options.json ? JSON.stringify(changes, null, 2) : formatCodexChangesHuman(changes));
        return;
      }

      const snapshot = createProjectInspectorSnapshot(process.cwd());
      console.log(options.json ? JSON.stringify(snapshot, null, 2) : formatInspectorHuman(snapshot));
    } catch (error) {
      handleError(error);
    }
  });

function printRegisteredProject(project: unknown): void {
  console.log(JSON.stringify(project, null, 2));
}

function parseNonNegativeIntegerOption(value: string, optionName: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${optionName} must be an integer.`);
  }
  return Number.parseInt(value, 10);
}

function parseProjectNameStyle(value: string): ProjectNameStyle {
  if (value !== "folder" && value !== "package" && value !== "git") {
    throw new Error("name-style must be folder, package, or git.");
  }
  return value;
}

function parseCommaList(value?: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function parseJsonObjectOption(value: string | undefined, optionName: string): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${optionName} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function resolveCliProject(id: string): { root: string; projectId: string; projectName?: string; registered: boolean } {
  const registeredProjects = listProjects(process.cwd());
  const registered = registeredProjects.length ? findProject(process.cwd(), id) : undefined;
  const fallbackId = projectIdFromRoot(process.cwd());
  const fallbackAllowed = !registeredProjects.length && id.toLowerCase() === fallbackId.toLowerCase();
  if (!registered && !fallbackAllowed) {
    throw new Error("Project is not registered.");
  }

  return {
    root: registered?.root ?? process.cwd(),
    projectId: registered?.id ?? fallbackId,
    ...(registered?.name ? { projectName: registered.name } : {}),
    registered: Boolean(registered)
  };
}

function resolveCliSessionProject(id?: string): string {
  if (id) {
    return resolveCliProject(id).projectId;
  }

  const active = readActiveProject(process.cwd()).active_project;
  if (active?.id) {
    return active.id;
  }

  const registeredProjects = listProjects(process.cwd());
  const currentProjectId = projectIdFromRoot(process.cwd());
  const currentRegisteredProject = registeredProjects.find((project) => project.id.toLowerCase() === currentProjectId.toLowerCase());
  if (currentRegisteredProject) {
    return currentRegisteredProject.id;
  }

  if (registeredProjects.length === 1) {
    return registeredProjects[0].id;
  }

  if (!registeredProjects.length) {
    return currentProjectId;
  }

  throw new Error("No active project selected. Run agentbridge project select <id> or pass a project id.");
}

function recordCliEvidence(projectId: string, input: Omit<AppendSessionEvidenceInput, "actor" | "source">): void {
  appendSessionEvidence(process.cwd(), projectId, {
    ...input,
    actor: "codex",
    source: "cli"
  });
}

function truncatedEvidenceStatus(truncated: boolean): "complete" | "truncated" {
  return truncated ? "truncated" : "complete";
}

function repoStatusCounts(statusShort: string): { staged_count: number; unstaged_count: number; untracked_count: number } {
  return statusShort
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("##"))
    .reduce(
      (counts, line) => {
        const code = line.slice(0, 2);
        if (code === "??") {
          counts.untracked_count += 1;
          return counts;
        }
        if (code[0] && code[0] !== " ") {
          counts.staged_count += 1;
        }
        if (code[1] && code[1] !== " ") {
          counts.unstaged_count += 1;
        }
        return counts;
      },
      { staged_count: 0, unstaged_count: 0, untracked_count: 0 }
    );
}

function headMetadata(recentCommits: string[]): { head_short_sha?: string; head_message?: string } {
  const head = recentCommits[0];
  if (!head) {
    return {};
  }
  const match = /^([0-9a-f]{6,40})\s+(.*)$/i.exec(head);
  if (!match) {
    return { head_message: head };
  }
  return { head_short_sha: match[1], head_message: match[2] };
}

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

const tunnel = program.command("tunnel").description("Manage a user-controlled secure tunnel bridge.");

tunnel
  .command("guide")
  .description("Print secure tunnel setup steps for cloudflared or ngrok.")
  .action(() => {
    console.log(tunnelGuide());
  });

tunnel
  .command("register")
  .description("Register a public HTTPS tunnel URL.")
  .argument("<public-url>", "public tunnel URL")
  .option("--allow-insecure", "allow http:// URLs for local testing only")
  .action((publicUrl: string, options: { allowInsecure?: boolean }) => {
    try {
      printResult(registerTunnel(process.cwd(), publicUrl, { allowInsecure: options.allowInsecure }));
    } catch (error) {
      handleError(error);
    }
  });

tunnel
  .command("status")
  .description("Print registered tunnel status without exposing the local token.")
  .action(() => {
    try {
      console.log(tunnelStatus());
    } catch (error) {
      handleError(error);
    }
  });

tunnel
  .command("test")
  .description("Test the registered tunnel against health, auth, repo, and safety endpoints.")
  .action(async () => {
    try {
      console.log(formatTunnelTestResult(await testTunnel()));
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

const session = program.command("session").description("Manage shared CodexLink workspace sessions.");

session
  .command("bootstrap")
  .description("Bootstrap or resume a shared session for a CodexLink client.")
  .argument("<projectId>", "safe project id")
  .option("--actor <actor>", "user, chatgpt, codex, or system", "codex")
  .option("--client <client>", "codex, chatgpt, user, or system", "codex")
  .option("--adapter <adapter>", "mcp, cli, or codex_plugin", "cli")
  .option("--source <source>", "bootstrap source label", "cli")
  .option("--mode <mode>", "start or resume", "start")
  .option("--json", "print JSON bootstrap result")
  .action(
    (
      projectId: string,
      options: {
        actor: string;
        client: string;
        adapter: string;
        source: string;
        mode: string;
        json?: boolean;
      }
    ) => {
      try {
        const resolvedProjectId = resolveCliSessionProject(projectId);
        const result = bootstrapSession(process.cwd(), resolvedProjectId, {
          actor: options.actor as SessionActor,
          client: options.client as SessionBootstrapClient,
          adapter: options.adapter as SessionBootstrapAdapter,
          source: options.source,
          mode: options.mode as SessionBootstrapMode
        });
        console.log(options.json ? JSON.stringify(result, null, 2) : formatSessionBootstrap(result));
      } catch (error) {
        handleError(error);
      }
    }
  );

session
  .command("active")
  .description("Get or create the active shared session.")
  .option("--json", "print JSON session view")
  .action((options: { json?: boolean }) => {
    try {
      const projectId = resolveCliSessionProject();
      const view = getOrCreateActiveSession(process.cwd(), projectId);
      console.log(options.json ? JSON.stringify(view, null, 2) : formatSessionSummary(view.summary));
    } catch (error) {
      handleError(error);
    }
  });

session
  .command("summary")
  .description("Get a compact shared session summary.")
  .argument("<projectId>", "safe project id")
  .option("--json", "print JSON summary")
  .action((projectId: string, options: { json?: boolean }) => {
    try {
      const resolvedProjectId = resolveCliSessionProject(projectId);
      const summary = getSessionSummary(process.cwd(), resolvedProjectId);
      console.log(options.json ? JSON.stringify({ ok: true, summary }, null, 2) : formatSessionSummary(summary));
    } catch (error) {
      handleError(error);
    }
  });

session
  .command("updates")
  .description("Get shared session updates after a revision.")
  .argument("<projectId>", "safe project id")
  .requiredOption("--since <revision>", "non-negative session revision")
  .option("--json", "print JSON updates")
  .action((projectId: string, options: { since: string; json?: boolean }) => {
    try {
      const resolvedProjectId = resolveCliSessionProject(projectId);
      const since = parseNonNegativeIntegerOption(options.since, "--since");
      const updates = getSessionUpdates(process.cwd(), resolvedProjectId, since);
      console.log(options.json ? JSON.stringify(updates, null, 2) : formatSessionUpdates(updates));
    } catch (error) {
      handleError(error);
    }
  });

session
  .command("evidence")
  .description("List recent shared session evidence metadata.")
  .argument("<projectId>", "safe project id")
  .option("--recent", "show recent evidence metadata", true)
  .option("--limit <count>", "maximum evidence entries", "8")
  .option("--json", "print JSON result")
  .action((projectId: string, options: { recent?: boolean; limit: string; json?: boolean }) => {
    try {
      const resolvedProjectId = resolveCliSessionProject(projectId);
      const limit = parseNonNegativeIntegerOption(options.limit, "--limit");
      const result = getRecentEvidence(process.cwd(), resolvedProjectId, limit || 8);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(
        [
          `Session evidence: ${resolvedProjectId}`,
          "",
          ...(result.evidence.length
            ? result.evidence.map((item) => `- r${item.revision} ${item.kind}/${item.status}${item.path ? ` ${item.path}` : ""}`)
            : ["- None"])
        ].join("\n")
      );
    } catch (error) {
      handleError(error);
    }
  });

session
  .command("checks")
  .description("List recent shared session check metadata.")
  .argument("<projectId>", "safe project id")
  .option("--recent", "show recent check metadata", true)
  .option("--limit <count>", "maximum check entries", "8")
  .option("--json", "print JSON result")
  .action((projectId: string, options: { recent?: boolean; limit: string; json?: boolean }) => {
    try {
      const resolvedProjectId = resolveCliSessionProject(projectId);
      const limit = parseNonNegativeIntegerOption(options.limit, "--limit");
      const result = getRecentChecks(process.cwd(), resolvedProjectId, limit || 8);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(
        [
          `Session checks: ${resolvedProjectId}`,
          "",
          ...(result.checks.length
            ? result.checks.map((item) => `- r${item.revision} ${item.type}/${item.status}: ${item.summary}`)
            : ["- None"])
        ].join("\n")
      );
    } catch (error) {
      handleError(error);
    }
  });

session
  .command("activity")
  .description("List recent shared session activity timeline metadata.")
  .argument("<projectId>", "safe project id")
  .option("--recent", "show recent activity timeline", true)
  .option("--limit <count>", "maximum activity entries", "10")
  .option("--json", "print JSON result")
  .action((projectId: string, options: { recent?: boolean; limit: string; json?: boolean }) => {
    try {
      const resolvedProjectId = resolveCliSessionProject(projectId);
      const limit = parseNonNegativeIntegerOption(options.limit, "--limit");
      const result = getRecentActivity(process.cwd(), resolvedProjectId, limit || 10);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(
        [
          `Session activity: ${resolvedProjectId}`,
          "",
          ...(result.activities.length
            ? result.activities.map((item) => `- r${item.revision} ${item.actor}/${item.kind}/${item.status}: ${item.summary}`)
            : ["- None"])
        ].join("\n")
      );
    } catch (error) {
      handleError(error);
    }
  });

session
  .command("activity-add")
  .description("Append shared session activity metadata without storing raw content.")
  .argument("<projectId>", "safe project id")
  .requiredOption("--kind <kind>", "activity kind")
  .requiredOption("--summary <summary>", "short activity summary")
  .option("--actor <actor>", "actor recording the activity", "codex")
  .option("--source <source>", "mcp, cli, http, gpt_actions, codex_plugin, doctor, smoke, script, or system", "cli")
  .option("--status <status>", "success, fail, warning, skipped, or unknown", "success")
  .option("--task-id <taskId>", "optional task id")
  .option("--correlation-id <id>", "optional correlation id")
  .option("--path <path>", "related path; repeatable", collectOption, [] as string[])
  .option("--metadata <json>", "optional small JSON metadata object")
  .option("--expected-revision <revision>", "optional optimistic concurrency revision")
  .option("--json", "print JSON result")
  .action(
    (
      projectId: string,
      options: {
        kind: string;
        summary: string;
        actor: string;
        source: string;
        status: string;
        taskId?: string;
        correlationId?: string;
        path: string[];
        metadata?: string;
        expectedRevision?: string;
        json?: boolean;
      }
    ) => {
      try {
        const resolvedProjectId = resolveCliSessionProject(projectId);
        const result = appendSessionActivity(process.cwd(), resolvedProjectId, {
          actor: options.actor as SessionActor,
          source: options.source as SessionActivitySource,
          kind: options.kind as SessionActivityKind,
          status: options.status as SessionActivityStatus,
          summary: options.summary,
          task_id: options.taskId,
          correlation_id: options.correlationId,
          paths: options.path,
          metadata: parseJsonObjectOption(options.metadata, "--metadata"),
          ...(options.expectedRevision ? { expected_revision: parseNonNegativeIntegerOption(options.expectedRevision, "--expected-revision") } : {})
        });
        console.log(options.json ? JSON.stringify(result, null, 2) : formatSessionSummary(result.summary));
      } catch (error) {
        handleError(error);
      }
    }
  );

session
  .command("check")
  .description("Append shared session check metadata without running a command.")
  .argument("<projectId>", "safe project id")
  .requiredOption("--type <type>", "build, test, diff_check, workflow, git_status, or smoke")
  .requiredOption("--status <status>", "pass, fail, warning, unknown, or skipped")
  .requiredOption("--summary <summary>", "short check summary")
  .option("--actor <actor>", "actor recording the check", "codex")
  .option("--command <command>", "command that produced this result")
  .option("--exit-code <code>", "non-negative exit code")
  .option("--duration-ms <ms>", "non-negative duration in milliseconds")
  .option("--expected-revision <revision>", "optional optimistic concurrency revision")
  .option("--json", "print JSON result")
  .action(
    (
      projectId: string,
      options: {
        type: string;
        status: string;
        summary: string;
        actor: string;
        command?: string;
        exitCode?: string;
        durationMs?: string;
        expectedRevision?: string;
        json?: boolean;
      }
    ) => {
      try {
        const resolvedProjectId = resolveCliSessionProject(projectId);
        const result = appendSessionCheck(process.cwd(), resolvedProjectId, {
          actor: options.actor as SessionActor,
          type: options.type as SessionCheckType,
          status: options.status as SessionCheckStatus,
          summary: options.summary,
          command: options.command,
          ...(options.exitCode ? { exit_code: parseNonNegativeIntegerOption(options.exitCode, "--exit-code") } : {}),
          ...(options.durationMs ? { duration_ms: parseNonNegativeIntegerOption(options.durationMs, "--duration-ms") } : {}),
          ...(options.expectedRevision ? { expected_revision: parseNonNegativeIntegerOption(options.expectedRevision, "--expected-revision") } : {})
        });
        console.log(options.json ? JSON.stringify(result, null, 2) : formatSessionSummary(result.summary));
      } catch (error) {
        handleError(error);
      }
    }
  );

session
  .command("event")
  .description("Append a shared session event.")
  .argument("<projectId>", "safe project id")
  .requiredOption("--actor <actor>", "user, chatgpt, codex, or system")
  .requiredOption("--type <type>", "session event type")
  .requiredOption("--summary <summary>", "short event summary")
  .option("--details <details>", "optional event details")
  .option("--expected-revision <revision>", "optional optimistic concurrency revision")
  .option("--json", "print JSON result")
  .action(
    (
      projectId: string,
      options: { actor: string; type: string; summary: string; details?: string; expectedRevision?: string; json?: boolean }
    ) => {
      try {
        const resolvedProjectId = resolveCliSessionProject(projectId);
        const result = appendSessionEvent(process.cwd(), resolvedProjectId, {
          actor: options.actor as SessionActor,
          type: options.type as SessionEventType,
          summary: options.summary,
          details: options.details,
          ...(options.expectedRevision ? { expected_revision: parseNonNegativeIntegerOption(options.expectedRevision, "--expected-revision") } : {})
        });
        console.log(options.json ? JSON.stringify(result, null, 2) : formatSessionSummary(result.summary));
      } catch (error) {
        handleError(error);
      }
    }
  );

session
  .command("handoff")
  .description("Add a shared session handoff.")
  .argument("<projectId>", "safe project id")
  .requiredOption("--to <actor>", "handoff target actor")
  .requiredOption("--title <title>", "handoff title")
  .requiredOption("--message <message>", "handoff message")
  .option("--from <actor>", "handoff source actor", "chatgpt")
  .option("--constraints <items>", "comma-separated constraints")
  .option("--expected-output <items>", "comma-separated expected output items")
  .option("--expected-revision <revision>", "optional optimistic concurrency revision")
  .option("--json", "print JSON result")
  .action(
    (
      projectId: string,
      options: {
        to: string;
        title: string;
        message: string;
        from: string;
        constraints?: string;
        expectedOutput?: string;
        expectedRevision?: string;
        json?: boolean;
      }
    ) => {
      try {
        const resolvedProjectId = resolveCliSessionProject(projectId);
        const result = addSessionHandoff(process.cwd(), resolvedProjectId, {
          from: options.from as SessionActor,
          to: options.to as SessionActor,
          title: options.title,
          message: options.message,
          constraints: parseCommaList(options.constraints),
          expected_output: parseCommaList(options.expectedOutput),
          ...(options.expectedRevision ? { expected_revision: parseNonNegativeIntegerOption(options.expectedRevision, "--expected-revision") } : {})
        });
        console.log(options.json ? JSON.stringify(result, null, 2) : formatSessionHandoffs([result.handoff]));
      } catch (error) {
        handleError(error);
      }
    }
  );

session
  .command("handoffs")
  .description("List shared session handoffs.")
  .argument("<projectId>", "safe project id")
  .option("--open", "only show open/active handoffs")
  .option("--json", "print JSON result")
  .action((projectId: string, options: { open?: boolean; json?: boolean }) => {
    try {
      const resolvedProjectId = resolveCliSessionProject(projectId);
      const result = listSessionHandoffs(process.cwd(), resolvedProjectId);
      const handoffs = options.open
        ? result.handoffs.filter((handoff) => ["open", "acknowledged", "in_progress", "blocked"].includes(handoff.status))
        : result.handoffs;
      console.log(options.json ? JSON.stringify({ ...result, handoffs }, null, 2) : formatSessionHandoffs(handoffs));
    } catch (error) {
      handleError(error);
    }
  });

session
  .command("update-handoff")
  .description("Update a shared session handoff status.")
  .argument("<projectId>", "safe project id")
  .argument("<handoffId>", "handoff id")
  .requiredOption("--status <status>", "new handoff status")
  .option("--actor <actor>", "actor updating the handoff", "codex")
  .option("--summary <summary>", "optional result summary")
  .option("--expected-revision <revision>", "optional optimistic concurrency revision")
  .option("--json", "print JSON result")
  .action(
    (
      projectId: string,
      handoffId: string,
      options: { status: string; actor: string; summary?: string; expectedRevision?: string; json?: boolean }
    ) => {
      try {
        const resolvedProjectId = resolveCliSessionProject(projectId);
        const result = updateSessionHandoff(process.cwd(), resolvedProjectId, handoffId, {
          status: options.status as SessionHandoffStatus,
          actor: options.actor as SessionActor,
          result_summary: options.summary,
          ...(options.expectedRevision ? { expected_revision: parseNonNegativeIntegerOption(options.expectedRevision, "--expected-revision") } : {})
        });
        console.log(options.json ? JSON.stringify(result, null, 2) : formatSessionHandoffs([result.handoff]));
      } catch (error) {
        handleError(error);
      }
    }
  );

session
  .command("set-goal")
  .description("Set the current shared session goal.")
  .argument("<projectId>", "safe project id")
  .argument("<goal>", "session goal")
  .option("--actor <actor>", "actor setting the goal", "codex")
  .option("--phase <phase>", "planning, implementation, review, blocked, or done")
  .option("--status <status>", "active, in_progress, blocked, or done")
  .option("--expected-revision <revision>", "optional optimistic concurrency revision")
  .option("--json", "print JSON result")
  .action(
    (
      projectId: string,
      goal: string,
      options: { actor: string; phase?: string; status?: string; expectedRevision?: string; json?: boolean }
    ) => {
      try {
        const resolvedProjectId = resolveCliSessionProject(projectId);
        const result = setSessionGoal(process.cwd(), resolvedProjectId, {
          actor: options.actor as SessionActor,
          goal,
          ...(options.phase ? { phase: options.phase as SessionPhase } : {}),
          ...(options.status ? { status: options.status as SessionCurrentStatus } : {}),
          ...(options.expectedRevision ? { expected_revision: parseNonNegativeIntegerOption(options.expectedRevision, "--expected-revision") } : {})
        });
        console.log(options.json ? JSON.stringify(result, null, 2) : formatSessionSummary(result.summary));
      } catch (error) {
        handleError(error);
      }
    }
  );

const project = program.command("project").description("Manage the local AgentBridge project registry.");

project
  .command("register")
  .description("Register an explicitly allowed local project.")
  .argument("<id>", "safe project id")
  .argument("<path>", "project path")
  .action((id: string, projectPath: string) => {
    try {
      printRegisteredProject(registerProject(process.cwd(), id, projectPath, "manual"));
    } catch (error) {
      handleError(error);
    }
  });

project
  .command("register-current")
  .description("Register the current working directory as an allowed project.")
  .argument("[id]", "optional safe project id")
  .action((id?: string) => {
    try {
      printRegisteredProject(registerCurrentProject(process.cwd(), id));
    } catch (error) {
      handleError(error);
    }
  });

project
  .command("list")
  .description("List explicitly registered local projects.")
  .option("--json", "print the registry as JSON")
  .action((options: { json?: boolean }) => {
    const projects = listProjects(process.cwd());
    if (options.json) {
      console.log(JSON.stringify({ registry: registryPath(process.cwd()), version: 1, projects }, null, 2));
      return;
    }

    console.log(formatProjectList(projects, process.cwd()));
  });

project
  .command("scan")
  .description("Safely scan a user-selected folder for candidate projects.")
  .argument("<root>", "folder to scan")
  .option("--preview", "preview candidate projects without writing the registry")
  .option("--register", "register discovered candidate projects")
  .option("--select <indexes>", "comma-separated 1-based candidate indexes to register")
  .option("--max-depth <n>", "maximum directory depth to scan", "4")
  .option("--max-projects <n>", "maximum candidate projects to return", "50")
  .option("--json", "print scan result as JSON")
  .option("--include-non-git", "include non-git strong-marker projects; enabled by default")
  .option("--name-style <style>", "candidate name style: folder, package, or git", "folder")
  .action(
    (
      scanRootInput: string,
      options: {
        preview?: boolean;
        register?: boolean;
        select?: string;
        maxDepth: string;
        maxProjects: string;
        json?: boolean;
        includeNonGit?: boolean;
        nameStyle: string;
      }
    ) => {
      try {
        if (options.preview && options.register) {
          throw new Error("Use either --preview or --register, not both.");
        }
        if (!options.preview && !options.register) {
          throw new Error("Use --preview to review candidates or --register to write selected candidates.");
        }
        if (options.select && !options.register) {
          throw new Error("--select requires --register.");
        }

        const maxDepth = parseNonNegativeIntegerOption(options.maxDepth, "--max-depth");
        const maxProjects = parseNonNegativeIntegerOption(options.maxProjects, "--max-projects");
        const nameStyle = parseProjectNameStyle(options.nameStyle);
        const discoverOptions = normalizeDiscoverOptions({
          maxDepth,
          maxProjects,
          includeNonGit: true,
          nameStyle
        });
        const scanRoot = validateScanRoot(scanRootInput);
        const candidates = discoverProjects(scanRoot, discoverOptions);
        const selectedIndexes = options.register && options.select ? parseScanSelection(options.select, candidates.length) : candidates.map((_, index) => index);
        const registered = options.register
          ? selectedIndexes.map((index) => registerProject(process.cwd(), candidates[index].id, candidates[index].root, "scan"))
          : [];

        const result: ProjectScanResult = {
          ok: true,
          root: scanRoot,
          mode: options.register ? "register" : "preview",
          max_depth: discoverOptions.maxDepth,
          max_projects: discoverOptions.maxProjects,
          candidates,
          registered
        };
        console.log(options.json ? JSON.stringify(result, null, 2) : formatProjectScanResult(result));
      } catch (error) {
        handleError(error);
      }
    }
  );

project
  .command("remove")
  .description("Remove a project from the local registry without deleting its folder.")
  .argument("<id>", "safe project id")
  .action((id: string) => {
    try {
      console.log(JSON.stringify({ removed: removeProject(process.cwd(), id), registry: registryPath(process.cwd()) }, null, 2));
    } catch (error) {
      handleError(error);
    }
  });

project
  .command("tree")
  .description("Print a safe project tree for a registered project.")
  .argument("<id>", "safe project id")
  .option("--max-depth <n>", "maximum depth to traverse", "4")
  .option("--max-entries <n>", "maximum entries to return", "500")
  .option("--json", "print JSON tree result")
  .action((id: string, options: { maxDepth: string; maxEntries: string; json?: boolean }) => {
    try {
      const project = resolveCliProject(id);
      const result = getProjectTree(project.root, {
        projectId: project.projectId,
        maxDepth: parseNonNegativeIntegerOption(options.maxDepth, "--max-depth"),
        maxEntries: parseNonNegativeIntegerOption(options.maxEntries, "--max-entries")
      });
      recordCliEvidence(project.projectId, {
        kind: "tree_seen",
        status: truncatedEvidenceStatus(result.truncated),
        metadata: {
          max_depth: result.max_depth,
          max_entries: result.max_entries,
          returned_entries: result.returned_entries,
          total_files: result.total_files,
          total_folders: result.total_folders,
          truncated: result.truncated,
          tree_truncated: result.inventory.tree_truncated,
          coverage_warning: result.coverage_warning?.message ?? null,
          scale_hint: result.inventory.scale_hint
        }
      });
      console.log(options.json ? JSON.stringify(result, null, 2) : formatProjectTree(result));
    } catch (error) {
      handleError(error);
    }
  });

project
  .command("find-file")
  .description("Search safe project-relative file names and paths.")
  .argument("<id>", "safe project id")
  .argument("<query>", "file name/path substring")
  .option("--max-results <n>", "maximum matches to return", "50")
  .option("--max-depth <n>", "maximum depth to traverse", "8")
  .option("--case-sensitive", "use case-sensitive matching")
  .option("--json", "print JSON search result")
  .action((id: string, query: string, options: { maxResults: string; maxDepth: string; caseSensitive?: boolean; json?: boolean }) => {
    try {
      const project = resolveCliProject(id);
      const result = searchProjectFiles(project.root, {
        projectId: project.projectId,
        query,
        maxResults: parseNonNegativeIntegerOption(options.maxResults, "--max-results"),
        maxDepth: parseNonNegativeIntegerOption(options.maxDepth, "--max-depth"),
        caseSensitive: Boolean(options.caseSensitive)
      });
      recordCliEvidence(project.projectId, {
        kind: "file_search",
        status: truncatedEvidenceStatus(result.truncated),
        metadata: {
          query: result.query,
          result_count: result.matches.length,
          truncated: result.truncated
        }
      });
      console.log(options.json ? JSON.stringify(result, null, 2) : formatProjectFileSearch(result));
    } catch (error) {
      handleError(error);
    }
  });

project
  .command("read-file")
  .description("Read one safe project-relative text file.")
  .argument("<id>", "safe project id")
  .argument("<relativePath>", "project-relative file path")
  .option("--max-chars <n>", "maximum content characters to return", "20000")
  .option("--start-line <n>", "optional 1-based start line")
  .option("--num-lines <n>", "optional number of lines")
  .option("--json", "print JSON file result")
  .action((id: string, relativePath: string, options: { maxChars: string; startLine?: string; numLines?: string; json?: boolean }) => {
    try {
      const project = resolveCliProject(id);
      const result = readProjectFile(project.root, {
        projectId: project.projectId,
        relativePath,
        maxChars: parseNonNegativeIntegerOption(options.maxChars, "--max-chars"),
        ...(options.startLine ? { startLine: parseNonNegativeIntegerOption(options.startLine, "--start-line") } : {}),
        ...(options.numLines ? { numLines: parseNonNegativeIntegerOption(options.numLines, "--num-lines") } : {})
      });
      recordCliEvidence(project.projectId, {
        kind: "file_read",
        path: result.path,
        status: result.read_status === "complete" ? "complete" : "partial",
        metadata: {
          read_status: result.read_status,
          bytes_returned: result.bytes_returned,
          truncated: result.truncated,
          line_count: result.line_count,
          line_count_estimate: result.line_count_estimate,
          line_range_returned: result.line_range_returned,
          coverage_warning: result.coverage_warning,
          redacted: result.redacted,
          size: result.size
        }
      });
      console.log(options.json ? JSON.stringify(result, null, 2) : formatProjectFileRead(result));
    } catch (error) {
      handleError(error);
    }
  });

project
  .command("grep")
  .description("Search text inside safe project files.")
  .argument("<id>", "safe project id")
  .argument("<query>", "text to search for")
  .option("--max-matches <n>", "maximum matches to return", "50")
  .option("--max-file-size <n>", "maximum file size to search", "200000")
  .option("--max-depth <n>", "maximum depth to traverse", "8")
  .option("--case-sensitive", "use case-sensitive matching")
  .option("--json", "print JSON grep result")
  .action(
    (
      id: string,
      query: string,
      options: { maxMatches: string; maxFileSize: string; maxDepth: string; caseSensitive?: boolean; json?: boolean }
    ) => {
      try {
        const project = resolveCliProject(id);
        const result = searchProjectText(project.root, {
          projectId: project.projectId,
          query,
          maxMatches: parseNonNegativeIntegerOption(options.maxMatches, "--max-matches"),
        maxFileSize: parseNonNegativeIntegerOption(options.maxFileSize, "--max-file-size"),
        maxDepth: parseNonNegativeIntegerOption(options.maxDepth, "--max-depth"),
        caseSensitive: Boolean(options.caseSensitive)
      });
      recordCliEvidence(project.projectId, {
        kind: "grep_seen",
        status: truncatedEvidenceStatus(result.truncated),
        metadata: {
          query: result.query,
          match_count: result.matches.length,
          files_matched_count: new Set(result.matches.map((match) => match.path)).size,
          truncated: result.truncated,
          redacted: result.redacted
        }
      });
      console.log(options.json ? JSON.stringify(result, null, 2) : formatProjectTextSearch(result));
    } catch (error) {
      handleError(error);
      }
    }
  );

project
  .command("inspect")
  .description("Inspect a registered project by safe project id.")
  .argument("<id>", "safe project id")
  .option("--json", "print JSON inspector snapshot")
  .option("--changes", "focus on changed files and Codex progress/result")
  .action((id: string, options: { json?: boolean; changes?: boolean }) => {
    try {
      const registeredProjects = listProjects(process.cwd());
      const registered = registeredProjects.length ? findProject(process.cwd(), id) : undefined;
      const fallbackId = projectIdFromRoot(process.cwd());
      const fallbackAllowed = !registeredProjects.length && id.toLowerCase() === fallbackId.toLowerCase();
      if (!registered && !fallbackAllowed) {
        throw new Error("Project is not registered.");
      }

      const root = registered?.root ?? process.cwd();
      const projectId = registered?.id ?? fallbackId;
      const projectName = registered?.name;
      const commonOptions = {
        projectId,
        ...(projectName ? { projectName } : {}),
        registered: Boolean(registered)
      };
      if (options.changes) {
        const changes = createCodexChangesSummary(root, commonOptions);
        recordCliEvidence(projectId, {
          kind: "codex_changes_seen",
          status: changes.limits.truncated ? "partial" : "complete",
          metadata: {
            branch: changes.branch,
            clean: changes.clean,
            changed_count: changes.changed_files.length,
            diff_truncated: changes.limits.diff_truncated
          }
        });
        console.log(options.json ? JSON.stringify(changes, null, 2) : formatCodexChangesHuman(changes));
        return;
      }

      const snapshot = createProjectInspectorSnapshot(root, commonOptions);
      recordCliEvidence(projectId, {
        kind: "inspect_seen",
        status: snapshot.limits.truncated ? "partial" : "complete",
        metadata: {
          branch: snapshot.repo.branch,
          clean: snapshot.repo.clean,
          changed_count: snapshot.repo.changed_files.length,
          ...repoStatusCounts(snapshot.repo.status_short),
          ...headMetadata(snapshot.repo.recent_commits),
          pending_approvals: snapshot.safety.pending_approvals,
          diff_truncated: snapshot.limits.diff_truncated
        }
      });
      console.log(options.json ? JSON.stringify(snapshot, null, 2) : formatInspectorHuman(snapshot));
    } catch (error) {
      handleError(error);
    }
  });

project
  .command("select")
  .description("Select an active registered project.")
  .argument("<id>", "safe project id")
  .action((id: string) => {
    try {
      console.log(JSON.stringify(selectActiveProject(process.cwd(), id, "cli"), null, 2));
    } catch (error) {
      handleError(error);
    }
  });

project
  .command("active")
  .description("Print the active selected project.")
  .action(() => {
    console.log(JSON.stringify(readActiveProject(process.cwd()), null, 2));
  });

project
  .command("clear-active")
  .description("Clear the active selected project.")
  .action(() => {
    console.log(JSON.stringify(clearActiveProject(process.cwd()), null, 2));
  });

const projects = program.command("projects").description("Alias for local project registry commands.");

projects
  .command("list")
  .description("List registered projects.")
  .action(() => {
    console.log(JSON.stringify({ registry: registryPath(process.cwd()), version: 1, projects: listProjects(process.cwd()) }, null, 2));
  });

projects
  .command("add")
  .description("Register a project in the local AgentBridge registry using its folder name as the id.")
  .argument("[path]", "project path", process.cwd())
  .action((projectPath: string) => {
    try {
      printRegisteredProject(addProject(projectPath, process.cwd()));
    } catch (error) {
      handleError(error);
    }
  });

projects
  .command("remove")
  .description("Remove a project from the local AgentBridge registry.")
  .argument("<id>", "safe project id")
  .action((id: string) => {
    try {
      console.log(JSON.stringify({ removed: removeProject(process.cwd(), id), registry: registryPath(process.cwd()) }, null, 2));
    } catch (error) {
      handleError(error);
    }
  });

const setup = program.command("setup").description("Run CodexLink one-time setup helpers.");

setup
  .command("codex-plugin")
  .description("Validate CodexLink local plugin files and print enable/trust next steps.")
  .option("--dry-run", "validate without writing files")
  .option("--json", "print JSON result")
  .action((options: { dryRun?: boolean; json?: boolean }) => {
    try {
      const result = setupCodexPlugin(process.cwd(), { dryRun: Boolean(options.dryRun) });
      console.log(options.json ? JSON.stringify(result, null, 2) : formatSetupText("CodexLink Codex Plugin Setup", result));
    } catch (error) {
      handleError(error);
    }
  });

setup
  .command("gpt-actions")
  .description("Regenerate GPT Actions schema assets and print safe setup next steps.")
  .option("--dry-run", "validate without writing files")
  .option("--host <host>", "local server host", "127.0.0.1")
  .option("--port <port>", "local server port", "7777")
  .option("--json", "print JSON result")
  .action((options: { dryRun?: boolean; host: string; port: string; json?: boolean }) => {
    try {
      const port = Number.parseInt(options.port, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("Port must be an integer from 1 to 65535.");
      }
      const result = setupGptActions(process.cwd(), { dryRun: Boolean(options.dryRun), host: options.host, port });
      console.log(options.json ? JSON.stringify(result, null, 2) : formatSetupText("CodexLink GPT Actions Setup", result));
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("doctor")
  .description("Diagnose CodexLink plugin, MCP, GPT Actions, tunnel, session, and security setup.")
  .option("--project <projectId>", "project id to bootstrap/check")
  .option("--json", "print JSON result")
  .action(async (options: { project?: string; json?: boolean }) => {
    try {
      const result = await runDoctor(process.cwd(), { projectId: options.project });
      console.log(options.json ? JSON.stringify(result, null, 2) : formatDoctorText(result));
    } catch (error) {
      handleError(error);
    }
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
