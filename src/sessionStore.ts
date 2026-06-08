import fs from "node:fs";
import path from "node:path";
import { ensureDir, pathExists, readJsonIfExists } from "./fsx.js";
import { bridgePath } from "./paths.js";
import { validateProjectId } from "./registry.js";
import { sanitizeSessionText, sanitizeSessionTextArray } from "./sessionRedaction.js";
import {
  SESSION_SCHEMA_VERSION,
  type ActiveSessionFile,
  type AppendSessionActivityInput,
  type AppendSessionCheckInput,
  type AppendSessionEvidenceInput,
  type AddSessionHandoffInput,
  type AppendSessionEventInput,
  type SessionBootstrapAdapter,
  type SessionBootstrapClient,
  type SessionBootstrapInput,
  type SessionBootstrapMode,
  type SessionBootstrapResult,
  type SessionActor,
  type SessionActivityKind,
  type SessionActivitySource,
  type SessionActivityStatus,
  type SessionCheckStatus,
  type SessionCheckType,
  type SessionCurrentStatus,
  type SessionEvidenceKind,
  type SessionEvidenceSource,
  type SessionEvidenceStatus,
  type SessionEventType,
  type SessionHandoffStatus,
  type SessionPhase,
  type SessionRecommendedNextAction,
  type SessionUpdatesResult,
  type SetSessionGoalInput,
  type SharedSessionActivity,
  type SharedSessionActiveClient,
  type SharedSessionCheck,
  type SharedSessionEvidence,
  type SharedSessionEvent,
  type SharedSessionFile,
  type SharedSessionHandoff,
  type SharedSessionStateFile,
  type SharedSessionSummaryFile,
  type SharedSessionView,
  type UpdateSessionHandoffInput
} from "./sessionTypes.js";

const SUMMARY_MAX = 500;
const DETAILS_MAX = 2000;
const TITLE_MAX = 200;
const MESSAGE_MAX = 3000;
const ARRAY_ITEM_MAX = 500;
const ARRAY_MAX = 20;
const WARNING_MAX = 25;
const RECENT_EVENT_MAX = 10;
const OPEN_HANDOFF_MAX = 10;
const RECENT_EVIDENCE_MAX = 8;
const RECENT_CHECK_MAX = 8;
const RECENT_ACTIVITY_MAX = 10;
const ACTIVE_CLIENT_MAX = 10;
const BOOTSTRAP_TTL_MS = 10 * 60 * 1000;
const METADATA_STRING_MAX = 500;
const METADATA_ARRAY_MAX = 20;
const METADATA_KEY_MAX = 80;
const METADATA_JSON_MAX = 4000;
const SOURCE_MAX = 120;
const DEFAULT_SESSION_GOAL = "Shared workspace session is ready.";

const ACTORS = new Set<SessionActor>(["user", "chatgpt", "codex", "system"]);
const BOOTSTRAP_CLIENTS = new Set<SessionBootstrapClient>(["codex", "chatgpt", "user", "system"]);
const BOOTSTRAP_ADAPTERS = new Set<SessionBootstrapAdapter>(["mcp", "cli", "codex_plugin"]);
const BOOTSTRAP_MODES = new Set<SessionBootstrapMode>(["start", "resume"]);
const EVENT_TYPES = new Set<SessionEventType>([
  "note",
  "decision",
  "correction",
  "handoff",
  "implementation",
  "review",
  "test_result",
  "commit",
  "warning",
  "blocker"
]);
const HANDOFF_STATUSES = new Set<SessionHandoffStatus>([
  "open",
  "acknowledged",
  "in_progress",
  "done",
  "blocked",
  "cancelled",
  "superseded"
]);
const PHASES = new Set<SessionPhase>(["planning", "implementation", "review", "blocked", "done"]);
const CURRENT_STATUSES = new Set<SessionCurrentStatus>(["active", "in_progress", "blocked", "done"]);
const OPEN_HANDOFF_STATUSES = new Set<SessionHandoffStatus>(["open", "acknowledged", "in_progress", "blocked"]);
const EVIDENCE_KINDS = new Set<SessionEvidenceKind>([
  "tree_seen",
  "file_read",
  "file_search",
  "grep_seen",
  "inspect_seen",
  "codex_changes_seen",
  "review_packet_seen"
]);
const EVIDENCE_SOURCES = new Set<SessionEvidenceSource>(["http", "cli", "mcp", "github", "script", "system"]);
const EVIDENCE_STATUSES = new Set<SessionEvidenceStatus>(["seen", "complete", "partial", "truncated", "blocked", "error"]);
const CHECK_TYPES = new Set<SessionCheckType>(["build", "test", "diff_check", "workflow", "git_status", "smoke"]);
const CHECK_STATUSES = new Set<SessionCheckStatus>(["pass", "fail", "warning", "unknown", "skipped"]);
const ACTIVITY_STATUSES = new Set<SessionActivityStatus>(["success", "fail", "warning", "skipped", "unknown"]);
const ACTIVITY_KINDS = new Set<SessionActivityKind>([
  "session_bootstrap",
  "session_resume",
  "session_summary_read",
  "session_goal_set",
  "active_client_heartbeat",
  "handoff_seen",
  "handoff_added",
  "handoff_update",
  "handoff_acknowledged",
  "handoff_done",
  "handoff_blocked",
  "handoff_cancelled",
  "handoff_superseded",
  "file_create",
  "file_edit",
  "file_delete",
  "file_verify",
  "file_status",
  "file_diff_summary",
  "command_started",
  "command_finished",
  "check_logged",
  "test_passed",
  "test_failed",
  "build_passed",
  "build_failed",
  "tree_seen",
  "file_read_seen",
  "grep_seen",
  "inspect_seen",
  "evidence_recorded",
  "workspace_snapshot",
  "git_status_seen",
  "changed_files_summary",
  "activity_gap_detected",
  "secret_redacted",
  "raw_content_blocked",
  "content_truncated",
  "unsafe_path_blocked"
]);

export class SessionStoreError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "SessionStoreError";
    this.code = code;
    this.status = status;
  }
}

export function getOrCreateActiveSession(registryRoot: string, projectIdInput: string): SharedSessionView {
  const projectId = validateProjectId(projectIdInput);
  const active = readOrCreateActiveSession(registryRoot, projectId);
  const paths = sessionPaths(registryRoot, projectId, active.session_id);
  const session = readJsonIfExists<SharedSessionFile>(paths.session) ?? defaultSession(projectId, active.session_id, active.updated_at);
  const state = normalizeState(
    projectId,
    active.session_id,
    readJsonIfExists<SharedSessionStateFile>(paths.state) ?? defaultState(projectId, active.session_id, active.updated_at)
  );

  ensureSessionFiles(paths, active, session, state);
  const summary = rebuildSessionSummary(registryRoot, projectId);
  return { ok: true, active_session: active, session, state: readState(paths), summary };
}

export function getProjectSession(registryRoot: string, projectIdInput: string): SharedSessionView {
  return getOrCreateActiveSession(registryRoot, projectIdInput);
}

export function getSessionSummary(registryRoot: string, projectIdInput: string): SharedSessionSummaryFile {
  const { summary } = getOrCreateActiveSession(registryRoot, projectIdInput);
  return summary;
}

export function bootstrapSession(
  registryRoot: string,
  projectIdInput: string,
  input: SessionBootstrapInput = {}
): SessionBootstrapResult {
  const projectId = validateProjectId(projectIdInput);
  const actor = validateActor(input.actor ?? "codex");
  const client = validateBootstrapClient(input.client ?? "codex");
  const adapter = validateBootstrapAdapter(input.adapter ?? "mcp");
  const mode = validateBootstrapMode(input.mode ?? "start");
  const sourceText = sanitizeSessionText(input.source ?? adapter, SOURCE_MAX);
  const source = sourceText.text.trim() || adapter;
  const bundle = readSessionBundle(registryRoot, projectId);
  const now = new Date();
  const existingClient = bundle.state.active_clients.find(
    (item) => item.client === client && item.adapter === adapter && item.source === source
  );
  const lastSeen = existingClient ? Date.parse(existingClient.last_seen) : Number.NaN;
  const recentlyBootstrapped = existingClient !== undefined && Number.isFinite(lastSeen) && now.getTime() - lastSeen < BOOTSTRAP_TTL_MS;

  let state = bundle.state;
  let bootstrapEventCreated = false;
  if (!recentlyBootstrapped) {
    const revision = state.revision + 1;
    const event = createSystemEvent(
      bundle.paths.events,
      revision,
      actor,
      "note",
      "Codex session started",
      `Bootstrap mode=${mode}; client=${client}; adapter=${adapter}; source=${source}.`
    );
    appendJsonLine(bundle.paths.events, event);
    appendActivityRecord(
      bundle,
      projectId,
      {
        actor,
        source: input.source ?? adapter,
        kind: mode === "resume" ? "session_resume" : "session_bootstrap",
        status: "success",
        summary: `Session ${mode === "resume" ? "resumed" : "bootstrapped"} by ${client}/${adapter}.`,
        related: { event_id: event.id },
        metadata: {
          client,
          adapter,
          mode,
          bootstrap_event_created: true,
          heartbeat_updated: true
        }
      },
      revision,
      state.revision,
      revision
    );
    state = updateStateForWrite(state, {
      revision,
      actor,
      lastEventId: event.id,
      warning:
        sourceText.redacted || sourceText.truncated
          ? "Some session bootstrap source metadata was redacted or truncated before storage."
          : undefined
    });
    bootstrapEventCreated = true;
  }

  const heartbeatAt = new Date().toISOString();
  state = {
    ...state,
    last_actor: actor,
    active_clients: upsertActiveClient(state.active_clients, {
      client,
      adapter,
      source,
      last_seen: heartbeatAt,
      last_tool: "session_bootstrap",
      status: "active",
      last_bootstrap_revision: state.revision
    }),
    updated_at: bootstrapEventCreated ? state.updated_at : heartbeatAt
  };
  writeStateSnapshots(bundle.paths, bundle.active, bundle.session, state);
  const summary = rebuildSessionSummary(registryRoot, projectId);
  return sessionBootstrapResult(summary, bootstrapEventCreated);
}

export function appendSessionEvent(
  registryRoot: string,
  projectIdInput: string,
  input: AppendSessionEventInput
): { ok: true; event: SharedSessionEvent; summary: SharedSessionSummaryFile; revision: number } {
  const projectId = validateProjectId(projectIdInput);
  const actor = validateActor(input.actor);
  const type = validateEventType(input.type);
  const summaryText = sanitizeSessionText(input.summary, SUMMARY_MAX);
  const detailsText = sanitizeSessionText(input.details ?? "", DETAILS_MAX);
  if (!summaryText.text.trim()) {
    throw new SessionStoreError("invalid_session_event", "Session event summary is required.");
  }

  const bundle = readSessionBundle(registryRoot, projectId);
  assertExpectedRevision(bundle.state.revision, input.expected_revision);
  const events = readJsonLines<SharedSessionEvent>(bundle.paths.events);
  const revision = bundle.state.revision + 1;
  const event: SharedSessionEvent = {
    id: eventId(events.length + 1),
    seq: events.length + 1,
    revision,
    time: new Date().toISOString(),
    actor,
    type,
    summary: summaryText.text.trim(),
    details: detailsText.text.trim(),
    redacted: summaryText.redacted || detailsText.redacted,
    truncated: summaryText.truncated || detailsText.truncated
  };

  appendJsonLine(bundle.paths.events, event);
  const state = updateStateForWrite(bundle.state, {
    revision,
    actor,
    lastEventId: event.id,
    warning: event.truncated ? "Some session event input was truncated before storage." : undefined
  });
  writeStateSnapshots(bundle.paths, bundle.active, bundle.session, state);
  const summary = rebuildSessionSummary(registryRoot, projectId);
  return { ok: true, event, summary, revision };
}

export function addSessionHandoff(
  registryRoot: string,
  projectIdInput: string,
  input: AddSessionHandoffInput
): { ok: true; handoff: SharedSessionHandoff; event: SharedSessionEvent; summary: SharedSessionSummaryFile; revision: number } {
  const projectId = validateProjectId(projectIdInput);
  const from = validateActor(input.from ?? "chatgpt");
  const to = validateActor(input.to);
  const title = sanitizeSessionText(input.title, TITLE_MAX);
  const message = sanitizeSessionText(input.message, MESSAGE_MAX);
  const constraints = sanitizeSessionTextArray(input.constraints, ARRAY_MAX, ARRAY_ITEM_MAX);
  const expectedOutput = sanitizeSessionTextArray(input.expected_output, ARRAY_MAX, ARRAY_ITEM_MAX);
  if (!title.text.trim()) {
    throw new SessionStoreError("invalid_session_handoff", "Session handoff title is required.");
  }
  if (!message.text.trim()) {
    throw new SessionStoreError("invalid_session_handoff", "Session handoff message is required.");
  }

  const bundle = readSessionBundle(registryRoot, projectId);
  assertExpectedRevision(bundle.state.revision, input.expected_revision);
  const handoffVersions = readJsonLines<SharedSessionHandoff>(bundle.paths.handoffs);
  const revision = bundle.state.revision + 1;
  const handoff: SharedSessionHandoff = {
    id: handoffId(countUniqueHandoffs(handoffVersions) + 1),
    seq: handoffVersions.length + 1,
    revision,
    time: new Date().toISOString(),
    from,
    to,
    status: "open",
    title: title.text.trim(),
    message: message.text.trim(),
    constraints: constraints.values,
    expected_output: expectedOutput.values,
    result_summary: null,
    redacted: title.redacted || message.redacted || constraints.redacted || expectedOutput.redacted,
    truncated: title.truncated || message.truncated || constraints.truncated || expectedOutput.truncated
  };

  appendJsonLine(bundle.paths.handoffs, handoff);
  const event = createSystemEvent(bundle.paths.events, revision, from, "handoff", `Handoff added: ${handoff.title}`, handoff.message);
  appendJsonLine(bundle.paths.events, event);
  appendActivityRecord(
    bundle,
    projectId,
    {
      actor: from,
      source: "system",
      kind: "handoff_added",
      status: "success",
      summary: `Handoff added: ${handoff.title}`,
      related: { event_id: event.id, handoff_id: handoff.id },
      metadata: {
        handoff_id: handoff.id,
        title: handoff.title,
        from,
        to,
        status_after: handoff.status,
        message_stored: false
      }
    },
    revision,
    bundle.state.revision,
    revision
  );
  const state = updateStateForWrite(bundle.state, {
    revision,
    actor: from,
    lastEventId: event.id,
    warning: handoff.truncated ? "Some session handoff input was truncated before storage." : undefined
  });
  writeStateSnapshots(bundle.paths, bundle.active, bundle.session, state);
  const summary = rebuildSessionSummary(registryRoot, projectId);
  return { ok: true, handoff, event, summary, revision };
}

export function updateSessionHandoff(
  registryRoot: string,
  projectIdInput: string,
  handoffIdInput: string,
  input: UpdateSessionHandoffInput
): { ok: true; handoff: SharedSessionHandoff; event: SharedSessionEvent; summary: SharedSessionSummaryFile; revision: number } {
  const projectId = validateProjectId(projectIdInput);
  const status = validateHandoffStatus(input.status);
  const actor = validateActor(input.actor ?? "codex");
  const resultSummary = sanitizeSessionText(input.result_summary ?? "", DETAILS_MAX);
  const bundle = readSessionBundle(registryRoot, projectId);
  assertExpectedRevision(bundle.state.revision, input.expected_revision);
  const handoffs = readJsonLines<SharedSessionHandoff>(bundle.paths.handoffs);
  const current = currentHandoffs(handoffs).find((handoff) => handoff.id === handoffIdInput);
  if (!current) {
    throw new SessionStoreError("handoff_not_found", "Session handoff was not found.", 404);
  }

  const revision = bundle.state.revision + 1;
  const updated: SharedSessionHandoff = {
    ...current,
    seq: handoffs.length + 1,
    revision,
    time: new Date().toISOString(),
    status,
    result_summary: resultSummary.text.trim() || current.result_summary,
    redacted: current.redacted || resultSummary.redacted,
    truncated: current.truncated || resultSummary.truncated
  };

  appendJsonLine(bundle.paths.handoffs, updated);
  const event = createSystemEvent(
    bundle.paths.events,
    revision,
    actor,
    "handoff",
    `Handoff ${handoffIdInput} marked ${status}.`,
    resultSummary.text
  );
  appendJsonLine(bundle.paths.events, event);
  appendActivityRecord(
    bundle,
    projectId,
    {
      actor,
      source: "system",
      kind: handoffActivityKind(status),
      status: status === "blocked" ? "warning" : status === "cancelled" ? "skipped" : "success",
      summary: `Handoff ${handoffIdInput} ${current.status} -> ${status}.`,
      related: { event_id: event.id, handoff_id: updated.id },
      metadata: {
        handoff_id: updated.id,
        title: updated.title,
        from: updated.from,
        to: updated.to,
        status_before: current.status,
        status_after: status,
        result_summary: resultSummary.text.trim() || null,
        revision_before: bundle.state.revision,
        revision_after: revision
      }
    },
    revision,
    bundle.state.revision,
    revision
  );
  const state = updateStateForWrite(bundle.state, {
    revision,
    actor,
    lastEventId: event.id,
    warning: updated.truncated ? "Some session handoff update input was truncated before storage." : undefined
  });
  writeStateSnapshots(bundle.paths, bundle.active, bundle.session, state);
  const summary = rebuildSessionSummary(registryRoot, projectId);
  return { ok: true, handoff: updated, event, summary, revision };
}

export function setSessionGoal(
  registryRoot: string,
  projectIdInput: string,
  input: SetSessionGoalInput
): { ok: true; summary: SharedSessionSummaryFile; revision: number; event: SharedSessionEvent } {
  const projectId = validateProjectId(projectIdInput);
  const actor = validateActor(input.actor ?? "codex");
  const phase = input.phase ? validatePhase(input.phase) : "planning";
  const status = input.status ? validateCurrentStatus(input.status) : "active";
  const goal = sanitizeSessionText(input.goal, SUMMARY_MAX);
  if (!goal.text.trim()) {
    throw new SessionStoreError("invalid_session_goal", "Session goal is required.");
  }

  const bundle = readSessionBundle(registryRoot, projectId);
  assertExpectedRevision(bundle.state.revision, input.expected_revision);
  const revision = bundle.state.revision + 1;
  const event = createSystemEvent(bundle.paths.events, revision, actor, "decision", "Session goal updated.", goal.text);
  appendJsonLine(bundle.paths.events, event);
  appendActivityRecord(
    bundle,
    projectId,
    {
      actor,
      source: "system",
      kind: "session_goal_set",
      status: "success",
      summary: "Session goal updated.",
      related: { event_id: event.id },
      metadata: {
        phase,
        status,
        goal_stored: true
      }
    },
    revision,
    bundle.state.revision,
    revision
  );
  const state = updateStateForWrite(
    {
      ...bundle.state,
      current: {
        goal: goal.text.trim(),
        phase,
        status
      }
    },
    {
      revision,
      actor,
      lastEventId: event.id,
      warning: goal.truncated ? "Session goal input was truncated before storage." : undefined
    }
  );
  const session: SharedSessionFile = {
    ...bundle.session,
    active_goal: goal.text.trim(),
    phase,
    updated_at: state.updated_at
  };
  writeStateSnapshots(bundle.paths, bundle.active, session, state);
  const summary = rebuildSessionSummary(registryRoot, projectId);
  return { ok: true, summary, revision, event };
}

export function appendSessionEvidence(
  registryRoot: string,
  projectIdInput: string,
  input: AppendSessionEvidenceInput
): { ok: true; evidence: SharedSessionEvidence; summary: SharedSessionSummaryFile; revision: number } {
  const projectId = validateProjectId(projectIdInput);
  const actor = validateActor(input.actor ?? "system");
  const kind = validateEvidenceKind(input.kind);
  const source = validateEvidenceSource(input.source);
  const status = validateEvidenceStatus(input.status);
  const pathValue = input.path ? sanitizeSessionText(input.path, METADATA_STRING_MAX) : undefined;
  const purpose = input.purpose ? sanitizeSessionText(input.purpose, SUMMARY_MAX) : undefined;
  const metadata = sanitizeSessionMetadata(input.metadata ?? {});

  const bundle = readSessionBundle(registryRoot, projectId);
  assertExpectedRevision(bundle.state.revision, input.expected_revision);
  const evidenceItems = readJsonLines<SharedSessionEvidence>(bundle.paths.evidence);
  const revision = bundle.state.revision + 1;
  const evidence: SharedSessionEvidence = {
    id: evidenceId(evidenceItems.length + 1),
    seq: evidenceItems.length + 1,
    revision,
    time: new Date().toISOString(),
    actor,
    kind,
    source,
    project_id: projectId,
    ...(pathValue?.text.trim() ? { path: pathValue.text.trim() } : {}),
    status,
    ...(purpose?.text.trim() ? { purpose: purpose.text.trim() } : {}),
    metadata: metadata.value,
    redacted: Boolean(pathValue?.redacted || purpose?.redacted || metadata.redacted),
    truncated: Boolean(pathValue?.truncated || purpose?.truncated || metadata.truncated)
  };

  appendJsonLine(bundle.paths.evidence, evidence);
  appendActivityRecord(
    bundle,
    projectId,
    {
      actor,
      source,
      kind: "evidence_recorded",
      status: status === "error" ? "fail" : status === "blocked" ? "warning" : "success",
      summary: `Evidence recorded: ${kind}/${status}`,
      related: { evidence_id: evidence.id },
      paths: evidence.path ? [evidence.path] : [],
      metadata: {
        evidence_id: evidence.id,
        evidence_kind: kind,
        evidence_source: source,
        evidence_status: status,
        path: evidence.path ?? null,
        content_stored: false
      }
    },
    revision,
    bundle.state.revision,
    revision
  );
  const state = updateStateForWrite(bundle.state, {
    revision,
    actor,
    warning: evidence.truncated ? "Some session evidence metadata was truncated before storage." : undefined
  });
  writeStateSnapshots(bundle.paths, bundle.active, bundle.session, state);
  const summary = rebuildSessionSummary(registryRoot, projectId);
  return { ok: true, evidence, summary, revision };
}

export function appendSessionCheck(
  registryRoot: string,
  projectIdInput: string,
  input: AppendSessionCheckInput
): { ok: true; check: SharedSessionCheck; summary: SharedSessionSummaryFile; revision: number } {
  const projectId = validateProjectId(projectIdInput);
  const actor = validateActor(input.actor ?? "codex");
  const type = validateCheckType(input.type);
  const status = validateCheckStatus(input.status);
  const command = input.command ? sanitizeSessionText(input.command, SUMMARY_MAX) : undefined;
  const summaryText = sanitizeSessionText(input.summary, SUMMARY_MAX);
  if (!summaryText.text.trim()) {
    throw new SessionStoreError("invalid_session_check", "Session check summary is required.");
  }
  if (input.exit_code !== undefined && (!Number.isInteger(input.exit_code) || input.exit_code < 0)) {
    throw new SessionStoreError("invalid_session_check", "Session check exit_code must be a non-negative integer.");
  }
  if (input.duration_ms !== undefined && (!Number.isInteger(input.duration_ms) || input.duration_ms < 0)) {
    throw new SessionStoreError("invalid_session_check", "Session check duration_ms must be a non-negative integer.");
  }

  const bundle = readSessionBundle(registryRoot, projectId);
  assertExpectedRevision(bundle.state.revision, input.expected_revision);
  const checks = readJsonLines<SharedSessionCheck>(bundle.paths.checks);
  const revision = bundle.state.revision + 1;
  const check: SharedSessionCheck = {
    id: checkId(checks.length + 1),
    seq: checks.length + 1,
    revision,
    time: new Date().toISOString(),
    actor,
    type,
    ...(command?.text.trim() ? { command: command.text.trim() } : {}),
    status,
    ...(input.exit_code !== undefined ? { exit_code: input.exit_code } : {}),
    summary: summaryText.text.trim(),
    ...(input.duration_ms !== undefined ? { duration_ms: input.duration_ms } : {}),
    redacted: Boolean(command?.redacted || summaryText.redacted),
    truncated: Boolean(command?.truncated || summaryText.truncated)
  };

  appendJsonLine(bundle.paths.checks, check);
  appendActivityRecord(
    bundle,
    projectId,
    {
      actor,
      source: "system",
      kind: "check_logged",
      status: checkStatusToActivityStatus(status),
      summary: `Check logged: ${type}/${status}`,
      related: { check_id: check.id },
      metadata: {
        check_id: check.id,
        type,
        command: check.command ?? null,
        status,
        exit_code: check.exit_code ?? null,
        duration_ms: check.duration_ms ?? null,
        summary: check.summary,
        output_stored: false,
        redacted: check.redacted,
        truncated: check.truncated
      }
    },
    revision,
    bundle.state.revision,
    revision
  );
  const state = updateStateForWrite(bundle.state, {
    revision,
    actor,
    warning: check.truncated ? "Some session check metadata was truncated before storage." : undefined
  });
  writeStateSnapshots(bundle.paths, bundle.active, bundle.session, state);
  const summary = rebuildSessionSummary(registryRoot, projectId);
  return { ok: true, check, summary, revision };
}

export function appendSessionActivity(
  registryRoot: string,
  projectIdInput: string,
  input: AppendSessionActivityInput
): { ok: true; activity: SharedSessionActivity; summary: SharedSessionSummaryFile; revision: number } {
  const projectId = validateProjectId(projectIdInput);
  const bundle = readSessionBundle(registryRoot, projectId);
  assertExpectedRevision(bundle.state.revision, input.expected_revision);
  const revision = bundle.state.revision + 1;
  const revisionBefore = validateOptionalRevision(input.revision_before, "revision_before") ?? bundle.state.revision;
  const revisionAfter = validateOptionalRevision(input.revision_after, "revision_after") ?? revision;
  const activity = appendActivityRecord(bundle, projectId, input, revision, revisionBefore, revisionAfter);

  const state = updateStateForWrite(bundle.state, {
    revision,
    actor: activity.actor,
    warning:
      activity.redacted || activity.truncated
        ? "Some session activity metadata was redacted or truncated before storage."
        : undefined
  });
  writeStateSnapshots(bundle.paths, bundle.active, bundle.session, state);
  const summary = rebuildSessionSummary(registryRoot, projectId);
  return { ok: true, activity, summary, revision };
}

export function getSessionUpdates(registryRoot: string, projectIdInput: string, sinceRevisionInput: number): SessionUpdatesResult {
  const projectId = validateProjectId(projectIdInput);
  if (!Number.isInteger(sinceRevisionInput) || sinceRevisionInput < 0) {
    throw new SessionStoreError("invalid_query", "since_revision must be a non-negative integer.");
  }
  const bundle = readSessionBundle(registryRoot, projectId);
  const events = readJsonLines<SharedSessionEvent>(bundle.paths.events).filter((event) => event.revision > sinceRevisionInput);
  const handoffs = currentHandoffs(readJsonLines<SharedSessionHandoff>(bundle.paths.handoffs)).filter(
    (handoff) => handoff.revision > sinceRevisionInput
  );
  const evidence = readJsonLines<SharedSessionEvidence>(bundle.paths.evidence).filter((item) => item.revision > sinceRevisionInput);
  const checks = readJsonLines<SharedSessionCheck>(bundle.paths.checks).filter((item) => item.revision > sinceRevisionInput);
  const activity = readJsonLines<SharedSessionActivity>(bundle.paths.activity).filter((item) => item.revision > sinceRevisionInput);
  return {
    ok: true,
    project_id: projectId,
    session_id: bundle.session.session_id,
    from_revision: sinceRevisionInput,
    to_revision: bundle.state.revision,
    events,
    handoffs,
    evidence,
    checks,
    activity,
    summary_changed: bundle.state.revision > sinceRevisionInput
  };
}

export function getRecentEvidence(
  registryRoot: string,
  projectIdInput: string,
  limit = RECENT_EVIDENCE_MAX
): { ok: true; project_id: string; evidence: SharedSessionEvidence[] } {
  const projectId = validateProjectId(projectIdInput);
  const bundle = readSessionBundle(registryRoot, projectId);
  const cappedLimit = Math.max(1, Math.min(limit, 50));
  return { ok: true, project_id: projectId, evidence: readJsonLines<SharedSessionEvidence>(bundle.paths.evidence).slice(-cappedLimit) };
}

export function getRecentChecks(
  registryRoot: string,
  projectIdInput: string,
  limit = RECENT_CHECK_MAX
): { ok: true; project_id: string; checks: SharedSessionCheck[] } {
  const projectId = validateProjectId(projectIdInput);
  const bundle = readSessionBundle(registryRoot, projectId);
  const cappedLimit = Math.max(1, Math.min(limit, 50));
  return { ok: true, project_id: projectId, checks: readJsonLines<SharedSessionCheck>(bundle.paths.checks).slice(-cappedLimit) };
}

export function getRecentActivity(
  registryRoot: string,
  projectIdInput: string,
  limit = RECENT_ACTIVITY_MAX
): { ok: true; project_id: string; session_id: string; activities: SharedSessionActivity[]; has_more: boolean } {
  const projectId = validateProjectId(projectIdInput);
  const bundle = readSessionBundle(registryRoot, projectId);
  const cappedLimit = Math.max(1, Math.min(limit, 50));
  const activities = readJsonLines<SharedSessionActivity>(bundle.paths.activity);
  return {
    ok: true,
    project_id: projectId,
    session_id: bundle.session.session_id,
    activities: activities.slice(-cappedLimit),
    has_more: activities.length > cappedLimit
  };
}

export function getActivitySinceRevision(
  registryRoot: string,
  projectIdInput: string,
  sinceRevisionInput: number
): { ok: true; project_id: string; session_id: string; from_revision: number; to_revision: number; activities: SharedSessionActivity[] } {
  const projectId = validateProjectId(projectIdInput);
  if (!Number.isInteger(sinceRevisionInput) || sinceRevisionInput < 0) {
    throw new SessionStoreError("invalid_query", "since_revision must be a non-negative integer.");
  }
  const bundle = readSessionBundle(registryRoot, projectId);
  return {
    ok: true,
    project_id: projectId,
    session_id: bundle.session.session_id,
    from_revision: sinceRevisionInput,
    to_revision: bundle.state.revision,
    activities: readJsonLines<SharedSessionActivity>(bundle.paths.activity).filter((activity) => activity.revision > sinceRevisionInput)
  };
}

export function rebuildSessionSummary(registryRoot: string, projectIdInput: string): SharedSessionSummaryFile {
  const projectId = validateProjectId(projectIdInput);
  const bundle = readSessionBundle(registryRoot, projectId, { createIfMissing: true });
  const events = readJsonLines<SharedSessionEvent>(bundle.paths.events);
  const handoffs = currentHandoffs(readJsonLines<SharedSessionHandoff>(bundle.paths.handoffs));
  const openHandoffs = handoffs.filter((handoff) => OPEN_HANDOFF_STATUSES.has(handoff.status)).slice(-OPEN_HANDOFF_MAX);
  const activity = readJsonLines<SharedSessionActivity>(bundle.paths.activity);
  const recentActivity = activity.slice(-RECENT_ACTIVITY_MAX);
  const summary: SharedSessionSummaryFile = {
    schema_version: SESSION_SCHEMA_VERSION,
    project_id: projectId,
    session_id: bundle.session.session_id,
    revision: bundle.state.revision,
    one_line: bundle.state.current.goal || "Shared session is active.",
    current_goal: bundle.state.current.goal,
    current_status: bundle.state.current.status,
    phase: bundle.state.current.phase,
    recent_events: events.slice(-RECENT_EVENT_MAX),
    open_handoffs: openHandoffs,
    recent_evidence: readJsonLines<SharedSessionEvidence>(bundle.paths.evidence).slice(-RECENT_EVIDENCE_MAX),
    recent_checks: readJsonLines<SharedSessionCheck>(bundle.paths.checks).slice(-RECENT_CHECK_MAX),
    recent_activity: recentActivity,
    activity_counts: countActivityKinds(activity),
    active_clients: bundle.state.active_clients,
    next_steps: bundle.state.next_steps,
    do_not_do: bundle.state.do_not_do,
    warnings: activityWarnings(bundle.state.warnings, recentActivity),
    updated_at: bundle.state.updated_at
  };
  atomicWriteJson(bundle.paths.summary, summary);
  return summary;
}

export function formatSessionSummary(summary: SharedSessionSummaryFile): string {
  const lines = [
    `Session: ${summary.session_id}`,
    `Project: ${summary.project_id}`,
    `Revision: ${summary.revision}`,
    `Goal: ${summary.current_goal}`,
    `Phase: ${summary.phase}`,
    `Status: ${summary.current_status}`,
    "",
    "Open handoffs:",
    ...(summary.open_handoffs.length
      ? summary.open_handoffs.map((handoff) => `- ${handoff.id} [${handoff.status}] ${handoff.title}`)
      : ["- None"]),
    "",
    "Active clients:",
    ...(summary.active_clients.length
      ? summary.active_clients.map((client) => `- ${client.client}/${client.adapter} via ${client.source}: ${client.last_seen}`)
      : ["- None"]),
    "",
    "Recent events:",
    ...(summary.recent_events.length
      ? summary.recent_events.map((event) => `- r${event.revision} ${event.actor}/${event.type}: ${event.summary}`)
      : ["- None"]),
    "",
    "Recent activity:",
    ...(summary.recent_activity.length
      ? summary.recent_activity.map(
          (activity) =>
            `- r${activity.revision} ${activity.actor}/${activity.kind}/${activity.status}: ${activity.summary}${
              activity.truncated ? " (truncated)" : ""
            }`
        )
      : ["- None"]),
    "",
    "Recent evidence:",
    ...(summary.recent_evidence.length
      ? summary.recent_evidence.map(
          (evidence) =>
            `- r${evidence.revision} ${evidence.kind}/${evidence.status}${evidence.path ? ` ${evidence.path}` : ""}${
              evidence.truncated ? " (truncated)" : ""
            }`
        )
      : ["- None"]),
    "",
    "Recent checks:",
    ...(summary.recent_checks.length
      ? summary.recent_checks.map(
          (check) =>
            `- r${check.revision} ${check.type}/${check.status}${check.command ? ` ${check.command}` : ""}${
              check.truncated ? " (truncated)" : ""
            }`
        )
      : ["- None"])
  ];
  return lines.join("\n");
}

export function formatSessionBootstrap(result: SessionBootstrapResult): string {
  return [
    "Session bootstrap:",
    `Project: ${result.project_id}`,
    `Session: ${result.session_id}`,
    `Revision: ${result.revision}`,
    `Bootstrap event created: ${result.bootstrap_event_created ? "yes" : "no"}`,
    `Goal: ${result.current_goal}`,
    `Phase: ${result.phase}`,
    `Status: ${result.status}`,
    `Recommended next action: ${result.recommended_next_action}`,
    "",
    "Open handoffs:",
    ...(result.open_handoffs.length
      ? result.open_handoffs.map((handoff) => `- ${handoff.id} [${handoff.status}] ${handoff.title}`)
      : ["- None"]),
    "",
    "Recent events:",
    ...(result.recent_events.length
      ? result.recent_events.map((event) => `- r${event.revision} ${event.actor}/${event.type}: ${event.summary}`)
      : ["- None"])
  ].join("\n");
}

export function formatSessionUpdates(updates: SessionUpdatesResult): string {
  return [
    `Session updates: ${updates.project_id}`,
    `Revision: ${updates.from_revision} -> ${updates.to_revision}`,
    "",
    "Events:",
    ...(updates.events.length
      ? updates.events.map((event) => `- r${event.revision} ${event.actor}/${event.type}: ${event.summary}`)
      : ["- None"]),
    "",
    "Handoffs:",
    ...(updates.handoffs.length
      ? updates.handoffs.map((handoff) => `- r${handoff.revision} ${handoff.id} [${handoff.status}] ${handoff.title}`)
      : ["- None"]),
    "",
    "Evidence:",
    ...(updates.evidence.length
      ? updates.evidence.map(
          (evidence) =>
            `- r${evidence.revision} ${evidence.kind}/${evidence.status}${evidence.path ? ` ${evidence.path}` : ""}${
              evidence.truncated ? " (truncated)" : ""
            }`
        )
      : ["- None"]),
    "",
    "Checks:",
    ...(updates.checks.length
      ? updates.checks.map(
          (check) =>
            `- r${check.revision} ${check.type}/${check.status}${check.command ? ` ${check.command}` : ""}${
              check.truncated ? " (truncated)" : ""
            }`
        )
      : ["- None"]),
    "",
    "Activity:",
    ...(updates.activity.length
      ? updates.activity.map(
          (activity) =>
            `- r${activity.revision} ${activity.actor}/${activity.kind}/${activity.status}: ${activity.summary}${
              activity.truncated ? " (truncated)" : ""
            }`
        )
      : ["- None"])
  ].join("\n");
}

export function formatSessionHandoffs(handoffs: SharedSessionHandoff[]): string {
  return [
    "Session handoffs:",
    "",
    ...(handoffs.length
      ? handoffs.map((handoff) => `${handoff.id} [${handoff.status}] ${handoff.from} -> ${handoff.to}: ${handoff.title}`)
      : ["None"])
  ].join("\n");
}

export function listSessionHandoffs(
  registryRoot: string,
  projectIdInput: string,
  status?: SessionHandoffStatus
): { ok: true; project_id: string; handoffs: SharedSessionHandoff[] } {
  const projectId = validateProjectId(projectIdInput);
  const bundle = readSessionBundle(registryRoot, projectId);
  const handoffs = currentHandoffs(readJsonLines<SharedSessionHandoff>(bundle.paths.handoffs)).filter((handoff) =>
    status ? handoff.status === validateHandoffStatus(status) : true
  );
  return { ok: true, project_id: projectId, handoffs };
}

interface SessionPathSet {
  projectDir: string;
  sessionDir: string;
  active: string;
  session: string;
  state: string;
  summary: string;
  events: string;
  handoffs: string;
  evidence: string;
  checks: string;
  activity: string;
}

interface SessionBundle {
  paths: SessionPathSet;
  active: ActiveSessionFile;
  session: SharedSessionFile;
  state: SharedSessionStateFile;
}

function readSessionBundle(registryRoot: string, projectId: string, options: { createIfMissing?: boolean } = {}): SessionBundle {
  const active = options.createIfMissing === false ? readActiveSession(registryRoot, projectId) : readOrCreateActiveSession(registryRoot, projectId);
  const paths = sessionPaths(registryRoot, projectId, active.session_id);
  const session = readJsonIfExists<SharedSessionFile>(paths.session);
  const state = readJsonIfExists<SharedSessionStateFile>(paths.state);
  if (!session || !state) {
    if (options.createIfMissing === false) {
      throw new SessionStoreError("session_not_found", "Shared session was not found.", 404);
    }
    const now = new Date().toISOString();
    const createdSession = session ?? defaultSession(projectId, active.session_id, now);
    const createdState = normalizeState(projectId, active.session_id, state ?? defaultState(projectId, active.session_id, now));
    ensureSessionFiles(paths, active, createdSession, createdState);
    return { paths, active, session: createdSession, state: createdState };
  }
  return { paths, active, session, state: normalizeState(projectId, active.session_id, state) };
}

function readActiveSession(registryRoot: string, projectId: string): ActiveSessionFile {
  const active = readJsonIfExists<ActiveSessionFile>(activeSessionPath(registryRoot, projectId));
  if (!active) {
    throw new SessionStoreError("session_not_found", "Active shared session was not found.", 404);
  }
  return active;
}

function readOrCreateActiveSession(registryRoot: string, projectId: string): ActiveSessionFile {
  const existing = readJsonIfExists<ActiveSessionFile>(activeSessionPath(registryRoot, projectId));
  if (existing) {
    return existing;
  }
  const now = new Date().toISOString();
  const active: ActiveSessionFile = {
    schema_version: SESSION_SCHEMA_VERSION,
    project_id: projectId,
    session_id: defaultSessionId(projectId),
    revision: 1,
    updated_at: now
  };
  const paths = sessionPaths(registryRoot, projectId, active.session_id);
  ensureSessionFiles(paths, active, defaultSession(projectId, active.session_id, now), defaultState(projectId, active.session_id, now));
  rebuildSessionSummary(registryRoot, projectId);
  return active;
}

function ensureSessionFiles(
  paths: SessionPathSet,
  active: ActiveSessionFile,
  session: SharedSessionFile,
  state: SharedSessionStateFile
): void {
  ensureDir(paths.sessionDir);
  atomicWriteJson(paths.active, { ...active, revision: state.revision, updated_at: state.updated_at });
  atomicWriteJson(paths.session, session);
  atomicWriteJson(paths.state, state);
  if (!pathExists(paths.events)) {
    fs.writeFileSync(paths.events, "", "utf8");
  }
  if (!pathExists(paths.handoffs)) {
    fs.writeFileSync(paths.handoffs, "", "utf8");
  }
  if (!pathExists(paths.evidence)) {
    fs.writeFileSync(paths.evidence, "", "utf8");
  }
  if (!pathExists(paths.checks)) {
    fs.writeFileSync(paths.checks, "", "utf8");
  }
  if (!pathExists(paths.activity)) {
    fs.writeFileSync(paths.activity, "", "utf8");
  }
}

function writeStateSnapshots(
  paths: SessionPathSet,
  active: ActiveSessionFile,
  session: SharedSessionFile,
  state: SharedSessionStateFile
): void {
  const updatedActive: ActiveSessionFile = {
    ...active,
    revision: state.revision,
    updated_at: state.updated_at
  };
  const updatedSession: SharedSessionFile = {
    ...session,
    updated_at: state.updated_at,
    phase: state.current.phase,
    active_goal: state.current.goal
  };
  atomicWriteJson(paths.active, updatedActive);
  atomicWriteJson(paths.session, updatedSession);
  atomicWriteJson(paths.state, state);
}

function updateStateForWrite(
  state: SharedSessionStateFile,
  args: { revision: number; actor: SessionActor; lastEventId?: string; warning?: string }
): SharedSessionStateFile {
  const warnings = [...state.warnings];
  if (args.warning && !warnings.includes(args.warning)) {
    warnings.push(args.warning);
  }
  return {
    ...state,
    revision: args.revision,
    last_event_id: args.lastEventId ?? state.last_event_id,
    last_actor: args.actor,
    warnings: warnings.slice(-WARNING_MAX),
    updated_at: new Date().toISOString()
  };
}

function defaultSession(projectId: string, sessionId: string, now: string): SharedSessionFile {
  return {
    schema_version: SESSION_SCHEMA_VERSION,
    session_id: sessionId,
    project_id: projectId,
    created_at: now,
    updated_at: now,
    status: "active",
    phase: "planning",
    active_goal: "Shared workspace session is ready.",
    safety: {
      store_raw_file_content: false,
      store_secrets: false,
      allow_auto_push: false,
      allow_auto_release: false,
      allow_arbitrary_shell: false
    }
  };
}

function defaultState(projectId: string, sessionId: string, now: string): SharedSessionStateFile {
  return {
    schema_version: SESSION_SCHEMA_VERSION,
    project_id: projectId,
    session_id: sessionId,
    revision: 1,
    last_event_id: null,
    last_actor: "system",
    current: {
      goal: "Shared workspace session is ready.",
      phase: "planning",
      status: "active"
    },
    next_steps: [],
    do_not_do: [
      "Do not store raw file content or secrets in session.",
      "Do not add arbitrary command runner.",
      "Do not create releases or modify tags from session state."
    ],
    warnings: [],
    active_clients: [],
    updated_at: now
  };
}

function normalizeState(projectId: string, sessionId: string, state: SharedSessionStateFile): SharedSessionStateFile {
  const fallback = defaultState(projectId, sessionId, state.updated_at || new Date().toISOString());
  return {
    ...fallback,
    ...state,
    current: {
      ...fallback.current,
      ...(state.current ?? {})
    },
    next_steps: Array.isArray(state.next_steps) ? state.next_steps : [],
    do_not_do: Array.isArray(state.do_not_do) ? state.do_not_do : fallback.do_not_do,
    warnings: Array.isArray(state.warnings) ? state.warnings : [],
    active_clients: normalizeActiveClients((state as SharedSessionStateFile & { active_clients?: unknown }).active_clients)
  };
}

function readState(paths: SessionPathSet): SharedSessionStateFile {
  const state = readJsonIfExists<SharedSessionStateFile>(paths.state);
  if (!state) {
    throw new SessionStoreError("session_not_found", "Shared session state was not found.", 404);
  }
  return normalizeState(state.project_id, state.session_id, state);
}

function normalizeActiveClients(input: unknown): SharedSessionActiveClient[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const clients: SharedSessionActiveClient[] = [];
  for (const item of input.slice(-ACTIVE_CLIENT_MAX)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const raw = item as Partial<SharedSessionActiveClient>;
    if (!raw.client || !BOOTSTRAP_CLIENTS.has(raw.client)) {
      continue;
    }
    if (!raw.adapter || !BOOTSTRAP_ADAPTERS.has(raw.adapter)) {
      continue;
    }
    if (typeof raw.source !== "string" || !raw.source.trim()) {
      continue;
    }
    const source = sanitizeSessionText(raw.source, SOURCE_MAX).text.trim();
    const lastSeen = typeof raw.last_seen === "string" && !Number.isNaN(Date.parse(raw.last_seen)) ? raw.last_seen : new Date().toISOString();
    const revision =
      typeof raw.last_bootstrap_revision === "number" && Number.isInteger(raw.last_bootstrap_revision) && raw.last_bootstrap_revision >= 0
        ? raw.last_bootstrap_revision
        : 0;
    clients.push({
      client: raw.client,
      adapter: raw.adapter,
      source,
      last_seen: lastSeen,
      last_tool: "session_bootstrap",
      status: "active",
      last_bootstrap_revision: revision
    });
  }
  return clients;
}

function upsertActiveClient(
  activeClients: SharedSessionActiveClient[],
  nextClient: SharedSessionActiveClient
): SharedSessionActiveClient[] {
  const clients = activeClients.filter(
    (item) =>
      !(item.client === nextClient.client && item.adapter === nextClient.adapter && item.source === nextClient.source)
  );
  clients.push(nextClient);
  return clients.slice(-ACTIVE_CLIENT_MAX);
}

function sessionBootstrapResult(summary: SharedSessionSummaryFile, bootstrapEventCreated: boolean): SessionBootstrapResult {
  return {
    ok: true,
    project_id: summary.project_id,
    session_id: summary.session_id,
    revision: summary.revision,
    bootstrapped: true,
    bootstrap_event_created: bootstrapEventCreated,
    current_goal: summary.current_goal,
    phase: summary.phase,
    status: summary.current_status,
    open_handoffs: summary.open_handoffs,
    recent_events: summary.recent_events,
    recent_evidence: summary.recent_evidence,
    recent_checks: summary.recent_checks,
    recent_activity: summary.recent_activity,
    active_clients: summary.active_clients,
    do_not_do: summary.do_not_do,
    warnings: summary.warnings,
    recommended_next_action: recommendedNextAction(summary)
  };
}

function recommendedNextAction(summary: SharedSessionSummaryFile): SessionRecommendedNextAction {
  if (summary.open_handoffs.some((handoff) => handoff.to === "codex" && handoff.status === "open")) {
    return "acknowledge_open_handoff";
  }
  if (summary.current_status === "blocked" || summary.phase === "blocked") {
    return "review_blocker";
  }
  if (summary.recent_checks.some((check) => check.status === "fail")) {
    return "inspect_failed_check";
  }
  if (!summary.current_goal.trim() || summary.current_goal.trim() === DEFAULT_SESSION_GOAL) {
    return "set_goal_or_ask_user";
  }
  return "continue_current_goal";
}

function createSystemEvent(
  eventsPath: string,
  revision: number,
  actor: SessionActor,
  type: SessionEventType,
  summaryInput: string,
  detailsInput = ""
): SharedSessionEvent {
  const events = readJsonLines<SharedSessionEvent>(eventsPath);
  const summary = sanitizeSessionText(summaryInput, SUMMARY_MAX);
  const details = sanitizeSessionText(detailsInput, DETAILS_MAX);
  return {
    id: eventId(events.length + 1),
    seq: events.length + 1,
    revision,
    time: new Date().toISOString(),
    actor,
    type,
    summary: summary.text.trim(),
    details: details.text.trim(),
    redacted: summary.redacted || details.redacted,
    truncated: summary.truncated || details.truncated
  };
}

function currentHandoffs(handoffVersions: SharedSessionHandoff[]): SharedSessionHandoff[] {
  const byId = new Map<string, SharedSessionHandoff>();
  for (const handoff of handoffVersions) {
    byId.set(handoff.id, handoff);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function countUniqueHandoffs(handoffVersions: SharedSessionHandoff[]): number {
  return new Set(handoffVersions.map((handoff) => handoff.id)).size;
}

function readJsonLines<T>(filePath: string): T[] {
  if (!pathExists(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, "utf8").trim();
  if (!content) {
    return [];
  }
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

function appendJsonLine(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function atomicWriteJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function sessionPaths(registryRoot: string, projectId: string, sessionId: string): SessionPathSet {
  const projectDir = path.join(bridgePath(registryRoot, "sessions"), projectId);
  const sessionDir = path.join(projectDir, sessionId);
  return {
    projectDir,
    sessionDir,
    active: path.join(projectDir, "active_session.json"),
    session: path.join(sessionDir, "session.json"),
    state: path.join(sessionDir, "state.json"),
    summary: path.join(sessionDir, "summary.json"),
    events: path.join(sessionDir, "events.jsonl"),
    handoffs: path.join(sessionDir, "handoffs.jsonl"),
    evidence: path.join(sessionDir, "evidence.jsonl"),
    checks: path.join(sessionDir, "checks.jsonl"),
    activity: path.join(sessionDir, "activity.jsonl")
  };
}

function activeSessionPath(registryRoot: string, projectId: string): string {
  return path.join(bridgePath(registryRoot, "sessions"), projectId, "active_session.json");
}

function defaultSessionId(projectId: string): string {
  return `sess_${projectId.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 48) || "project"}_shared`;
}

function eventId(seq: number): string {
  return `evt_${seq.toString().padStart(6, "0")}`;
}

function handoffId(seq: number): string {
  return `handoff_${seq.toString().padStart(6, "0")}`;
}

function evidenceId(seq: number): string {
  return `evd_${seq.toString().padStart(6, "0")}`;
}

function checkId(seq: number): string {
  return `chk_${seq.toString().padStart(6, "0")}`;
}

function activityId(seq: number): string {
  return `act_${seq.toString().padStart(6, "0")}`;
}

function assertExpectedRevision(currentRevision: number, expectedRevision?: number): void {
  if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
    throw new SessionStoreError(
      "revision_conflict",
      `Session revision conflict. Current revision is ${currentRevision}. Read latest summary and retry.`,
      409
    );
  }
}

function validateOptionalRevision(value: number | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new SessionStoreError("invalid_session_activity", `${label} must be a non-negative integer.`);
  }
  return value;
}

function validateActor(value: string): SessionActor {
  if (!ACTORS.has(value as SessionActor)) {
    throw new SessionStoreError("invalid_actor", "Session actor must be user, chatgpt, codex, or system.");
  }
  return value as SessionActor;
}

function validateBootstrapClient(value: string): SessionBootstrapClient {
  if (!BOOTSTRAP_CLIENTS.has(value as SessionBootstrapClient)) {
    throw new SessionStoreError("invalid_bootstrap_client", "Session bootstrap client must be codex, chatgpt, user, or system.");
  }
  return value as SessionBootstrapClient;
}

function validateBootstrapAdapter(value: string): SessionBootstrapAdapter {
  if (!BOOTSTRAP_ADAPTERS.has(value as SessionBootstrapAdapter)) {
    throw new SessionStoreError("invalid_bootstrap_adapter", "Session bootstrap adapter must be mcp, cli, or codex_plugin.");
  }
  return value as SessionBootstrapAdapter;
}

function validateBootstrapMode(value: string): SessionBootstrapMode {
  if (!BOOTSTRAP_MODES.has(value as SessionBootstrapMode)) {
    throw new SessionStoreError("invalid_bootstrap_mode", "Session bootstrap mode must be start or resume.");
  }
  return value as SessionBootstrapMode;
}

function validateEventType(value: string): SessionEventType {
  if (!EVENT_TYPES.has(value as SessionEventType)) {
    throw new SessionStoreError("invalid_event_type", "Session event type is not allowed.");
  }
  return value as SessionEventType;
}

function validateHandoffStatus(value: string): SessionHandoffStatus {
  if (!HANDOFF_STATUSES.has(value as SessionHandoffStatus)) {
    throw new SessionStoreError("invalid_status", "Session handoff status is not allowed.");
  }
  return value as SessionHandoffStatus;
}

function validatePhase(value: string): SessionPhase {
  if (!PHASES.has(value as SessionPhase)) {
    throw new SessionStoreError("invalid_phase", "Session phase is not allowed.");
  }
  return value as SessionPhase;
}

function validateCurrentStatus(value: string): SessionCurrentStatus {
  if (!CURRENT_STATUSES.has(value as SessionCurrentStatus)) {
    throw new SessionStoreError("invalid_status", "Session current status is not allowed.");
  }
  return value as SessionCurrentStatus;
}

function validateEvidenceKind(value: string): SessionEvidenceKind {
  if (!EVIDENCE_KINDS.has(value as SessionEvidenceKind)) {
    throw new SessionStoreError("invalid_evidence_kind", "Session evidence kind is not allowed.");
  }
  return value as SessionEvidenceKind;
}

function validateEvidenceSource(value: string): SessionEvidenceSource {
  if (!EVIDENCE_SOURCES.has(value as SessionEvidenceSource)) {
    throw new SessionStoreError("invalid_evidence_source", "Session evidence source is not allowed.");
  }
  return value as SessionEvidenceSource;
}

function validateEvidenceStatus(value: string): SessionEvidenceStatus {
  if (!EVIDENCE_STATUSES.has(value as SessionEvidenceStatus)) {
    throw new SessionStoreError("invalid_evidence_status", "Session evidence status is not allowed.");
  }
  return value as SessionEvidenceStatus;
}

function validateCheckType(value: string): SessionCheckType {
  if (!CHECK_TYPES.has(value as SessionCheckType)) {
    throw new SessionStoreError("invalid_check_type", "Session check type is not allowed.");
  }
  return value as SessionCheckType;
}

function validateCheckStatus(value: string): SessionCheckStatus {
  if (!CHECK_STATUSES.has(value as SessionCheckStatus)) {
    throw new SessionStoreError("invalid_check_status", "Session check status is not allowed.");
  }
  return value as SessionCheckStatus;
}

function validateActivityKind(value: string): SessionActivityKind {
  if (!ACTIVITY_KINDS.has(value as SessionActivityKind)) {
    throw new SessionStoreError("invalid_activity_kind", "Session activity kind is not allowed.");
  }
  return value as SessionActivityKind;
}

function sanitizeActivitySource(value: string): { value: SessionActivitySource; redacted: boolean; truncated: boolean } {
  const sanitized = sanitizeSessionText(value, SOURCE_MAX);
  const source = sanitized.text.trim();
  if (!source) {
    throw new SessionStoreError("invalid_activity_source", "Session activity source is required.");
  }
  return { value: source as SessionActivitySource, redacted: sanitized.redacted, truncated: sanitized.truncated };
}

function validateActivityStatus(value: string): SessionActivityStatus {
  if (!ACTIVITY_STATUSES.has(value as SessionActivityStatus)) {
    throw new SessionStoreError("invalid_activity_status", "Session activity status is not allowed.");
  }
  return value as SessionActivityStatus;
}

function appendActivityRecord(
  bundle: SessionBundle,
  projectId: string,
  input: AppendSessionActivityInput,
  revision: number,
  revisionBefore: number,
  revisionAfter: number
): SharedSessionActivity {
  const actor = validateActor(input.actor ?? "codex");
  const source = sanitizeActivitySource(input.source);
  const kind = validateActivityKind(input.kind);
  const status = validateActivityStatus(input.status ?? "success");
  const summaryText = sanitizeSessionText(input.summary, SUMMARY_MAX);
  if (!summaryText.text.trim()) {
    throw new SessionStoreError("invalid_session_activity", "Session activity summary is required.");
  }
  const taskId = input.task_id ? sanitizeSessionText(input.task_id, METADATA_STRING_MAX) : undefined;
  const correlationId = input.correlation_id ? sanitizeSessionText(input.correlation_id, METADATA_STRING_MAX) : undefined;
  const paths = sanitizeSessionTextArray(input.paths ?? [], ARRAY_MAX, METADATA_STRING_MAX);
  const metadata = sanitizeSessionMetadata(input.metadata ?? {});
  const related = sanitizeActivityRelated(input.related);
  const activityItems = readJsonLines<SharedSessionActivity>(bundle.paths.activity);
  const activity: SharedSessionActivity = {
    id: activityId(activityItems.length + 1),
    seq: activityItems.length + 1,
    revision,
    time: new Date().toISOString(),
    project_id: projectId,
    session_id: bundle.session.session_id,
    actor,
    source: source.value,
    kind,
    status,
    summary: summaryText.text.trim(),
    ...(taskId?.text.trim() ? { task_id: taskId.text.trim() } : {}),
    ...(correlationId?.text.trim() ? { correlation_id: correlationId.text.trim() } : {}),
    revision_before: revisionBefore,
    revision_after: revisionAfter,
    ...(related.value ? { related: related.value } : {}),
    paths: paths.values,
    metadata: metadata.value,
    redacted: Boolean(
      summaryText.redacted || source.redacted || taskId?.redacted || correlationId?.redacted || paths.redacted || metadata.redacted || related.redacted
    ),
    truncated: Boolean(
      summaryText.truncated ||
        source.truncated ||
        taskId?.truncated ||
        correlationId?.truncated ||
        paths.truncated ||
        metadata.truncated ||
        related.truncated
    )
  };
  appendJsonLine(bundle.paths.activity, activity);
  return activity;
}

function handoffActivityKind(status: SessionHandoffStatus): SessionActivityKind {
  if (status === "acknowledged") {
    return "handoff_acknowledged";
  }
  if (status === "done") {
    return "handoff_done";
  }
  if (status === "blocked") {
    return "handoff_blocked";
  }
  if (status === "cancelled") {
    return "handoff_cancelled";
  }
  if (status === "superseded") {
    return "handoff_superseded";
  }
  return "handoff_update";
}

function checkStatusToActivityStatus(status: SessionCheckStatus): SessionActivityStatus {
  if (status === "pass") {
    return "success";
  }
  if (status === "fail") {
    return "fail";
  }
  if (status === "warning") {
    return "warning";
  }
  if (status === "skipped") {
    return "skipped";
  }
  return "unknown";
}

function countActivityKinds(activities: SharedSessionActivity[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const activity of activities) {
    counts[activity.kind] = (counts[activity.kind] ?? 0) + 1;
  }
  return counts;
}

function activityWarnings(existingWarnings: string[], recentActivity: SharedSessionActivity[]): string[] {
  const warnings = [...existingWarnings];
  if (recentActivity.some((activity) => activity.redacted || activity.truncated)) {
    const warning = "Some recent activity metadata was redacted or truncated.";
    if (!warnings.includes(warning)) {
      warnings.push(warning);
    }
  }
  return warnings.slice(-WARNING_MAX);
}

function sanitizeActivityRelated(input: AppendSessionActivityInput["related"]): {
  value?: SharedSessionActivity["related"];
  redacted: boolean;
  truncated: boolean;
} {
  if (!input || typeof input !== "object") {
    return { redacted: false, truncated: false };
  }
  const output: NonNullable<SharedSessionActivity["related"]> = {};
  let redacted = false;
  let truncated = false;
  for (const key of ["event_id", "handoff_id", "evidence_id", "check_id", "activity_id"] as const) {
    const value = input[key];
    if (value === null) {
      output[key] = null;
      continue;
    }
    if (typeof value === "string" && value.trim()) {
      const sanitized = sanitizeSessionText(value, METADATA_STRING_MAX);
      output[key] = sanitized.text.trim();
      redacted = redacted || sanitized.redacted;
      truncated = truncated || sanitized.truncated;
    }
  }
  return Object.keys(output).length ? { value: output, redacted, truncated } : { redacted, truncated };
}

function sanitizeSessionMetadata(input: Record<string, unknown>): {
  value: Record<string, unknown>;
  redacted: boolean;
  truncated: boolean;
} {
  const output: Record<string, unknown> = {};
  let redacted = false;
  let truncated = false;

  for (const [rawKey, rawValue] of Object.entries(input).slice(0, METADATA_ARRAY_MAX)) {
    const key = sanitizeMetadataKey(rawKey);
    if (!key || isBlockedMetadataKey(key)) {
      truncated = true;
      continue;
    }
    const sanitized = sanitizeMetadataValue(rawValue, 0, key);
    output[key] = sanitized.value;
    redacted = redacted || sanitized.redacted;
    truncated = truncated || sanitized.truncated;
  }

  const serialized = JSON.stringify(output);
  if (serialized.length > METADATA_JSON_MAX) {
    return {
      value: {
        note: "metadata truncated",
        original_keys: Object.keys(output).slice(0, METADATA_ARRAY_MAX)
      },
      redacted,
      truncated: true
    };
  }

  return { value: output, redacted, truncated };
}

function sanitizeMetadataValue(
  input: unknown,
  depth: number,
  key = ""
): { value: unknown; redacted: boolean; truncated: boolean } {
  if (input === null || typeof input === "boolean") {
    return { value: input, redacted: false, truncated: false };
  }
  if (typeof input === "number") {
    return { value: Number.isFinite(input) ? input : null, redacted: false, truncated: !Number.isFinite(input) };
  }
  if (typeof input === "string") {
    if (key.toLowerCase() === "query" && looksSensitiveMetadataQuery(input)) {
      return { value: "[REDACTED]", redacted: true, truncated: false };
    }
    const sanitized = sanitizeSessionText(input, METADATA_STRING_MAX);
    return { value: sanitized.text, redacted: sanitized.redacted, truncated: sanitized.truncated };
  }
  if (Array.isArray(input)) {
    const values: unknown[] = [];
    let redacted = false;
    let truncated = input.length > METADATA_ARRAY_MAX;
    for (const item of input.slice(0, METADATA_ARRAY_MAX)) {
      const sanitized = sanitizeMetadataValue(item, depth + 1, key);
      values.push(sanitized.value);
      redacted = redacted || sanitized.redacted;
      truncated = truncated || sanitized.truncated;
    }
    return { value: values, redacted, truncated };
  }
  if (input && typeof input === "object" && depth < 2) {
    const sanitized = sanitizeSessionMetadata(input as Record<string, unknown>);
    return sanitized;
  }
  return { value: String(input ?? ""), redacted: false, truncated: true };
}

function sanitizeMetadataKey(input: string): string {
  return input.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, METADATA_KEY_MAX);
}

function isBlockedMetadataKey(key: string): boolean {
  return /^(content|raw_content|file_content|body|diff|raw_diff|patch|snippet|stdout|stderr|output|raw_output|terminal_output|authorization|local_token)$/i.test(
    key
  );
}

function looksSensitiveMetadataQuery(input: string): boolean {
  const value = input.trim();
  return (
    value.length >= 20 &&
    (/(?:token|secret|key|password|auth|jwt|bearer|credential|manual_grep|gamma_grep|codexlink_gamma)/i.test(value) ||
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(value) ||
      (/[A-Z]/.test(value) && /[0-9]/.test(value) && /[_-]/.test(value)))
  );
}
