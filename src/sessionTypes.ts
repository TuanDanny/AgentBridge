export const SESSION_SCHEMA_VERSION = 1;

export type SessionActor = "user" | "chatgpt" | "codex" | "system";

export type SessionEventType =
  | "note"
  | "decision"
  | "correction"
  | "handoff"
  | "implementation"
  | "review"
  | "test_result"
  | "commit"
  | "warning"
  | "blocker";

export type SessionHandoffStatus =
  | "open"
  | "acknowledged"
  | "in_progress"
  | "done"
  | "blocked"
  | "cancelled"
  | "superseded";

export type SessionPhase = "planning" | "implementation" | "review" | "blocked" | "done";
export type SessionCurrentStatus = "active" | "in_progress" | "blocked" | "done";
export type SessionEvidenceKind =
  | "tree_seen"
  | "file_read"
  | "file_search"
  | "grep_seen"
  | "inspect_seen"
  | "codex_changes_seen"
  | "review_packet_seen";
export type SessionEvidenceSource = "http" | "cli" | "mcp" | "github" | "script" | "system";
export type SessionEvidenceStatus = "seen" | "complete" | "partial" | "truncated" | "blocked" | "error";
export type SessionCheckType = "build" | "test" | "diff_check" | "workflow" | "git_status" | "smoke";
export type SessionCheckStatus = "pass" | "fail" | "warning" | "unknown" | "skipped";
export type SessionBootstrapClient = "codex" | "chatgpt" | "user" | "system";
export type SessionBootstrapAdapter = "mcp" | "cli" | "codex_plugin";
export type SessionBootstrapMode = "start" | "resume";
export type SessionRecommendedNextAction =
  | "acknowledge_open_handoff"
  | "review_blocker"
  | "inspect_failed_check"
  | "set_goal_or_ask_user"
  | "continue_current_goal";

export interface SharedSessionActiveClient {
  client: SessionBootstrapClient;
  adapter: SessionBootstrapAdapter;
  source: string;
  last_seen: string;
  last_tool: "session_bootstrap";
  status: "active";
  last_bootstrap_revision: number;
}

export interface ActiveSessionFile {
  schema_version: 1;
  project_id: string;
  session_id: string;
  revision: number;
  updated_at: string;
}

export interface SharedSessionFile {
  schema_version: 1;
  session_id: string;
  project_id: string;
  created_at: string;
  updated_at: string;
  status: "active" | "archived";
  phase: SessionPhase;
  active_goal: string;
  safety: {
    store_raw_file_content: false;
    store_secrets: false;
    allow_auto_push: false;
    allow_auto_release: false;
    allow_arbitrary_shell: false;
  };
}

export interface SharedSessionStateFile {
  schema_version: 1;
  project_id: string;
  session_id: string;
  revision: number;
  last_event_id: string | null;
  last_actor: SessionActor;
  current: {
    goal: string;
    phase: SessionPhase;
    status: SessionCurrentStatus;
  };
  next_steps: string[];
  do_not_do: string[];
  warnings: string[];
  active_clients: SharedSessionActiveClient[];
  updated_at: string;
}

export interface SharedSessionEvent {
  id: string;
  seq: number;
  revision: number;
  time: string;
  actor: SessionActor;
  type: SessionEventType;
  summary: string;
  details: string;
  redacted: boolean;
  truncated: boolean;
}

export interface SharedSessionHandoff {
  id: string;
  seq: number;
  revision: number;
  time: string;
  from: SessionActor;
  to: SessionActor;
  status: SessionHandoffStatus;
  title: string;
  message: string;
  constraints: string[];
  expected_output: string[];
  result_summary: string | null;
  redacted: boolean;
  truncated: boolean;
}

export interface SharedSessionEvidence {
  id: string;
  seq: number;
  revision: number;
  time: string;
  actor: SessionActor;
  kind: SessionEvidenceKind;
  source: SessionEvidenceSource;
  project_id: string;
  path?: string;
  status: SessionEvidenceStatus;
  purpose?: string;
  metadata: Record<string, unknown>;
  redacted: boolean;
  truncated: boolean;
}

export interface SharedSessionCheck {
  id: string;
  seq: number;
  revision: number;
  time: string;
  actor: SessionActor;
  type: SessionCheckType;
  command?: string;
  status: SessionCheckStatus;
  exit_code?: number;
  summary: string;
  duration_ms?: number;
  redacted: boolean;
  truncated: boolean;
}

export interface SharedSessionSummaryFile {
  schema_version: 1;
  project_id: string;
  session_id: string;
  revision: number;
  one_line: string;
  current_goal: string;
  current_status: SessionCurrentStatus;
  phase: SessionPhase;
  recent_events: SharedSessionEvent[];
  open_handoffs: SharedSessionHandoff[];
  recent_evidence: SharedSessionEvidence[];
  recent_checks: SharedSessionCheck[];
  active_clients: SharedSessionActiveClient[];
  next_steps: string[];
  do_not_do: string[];
  warnings: string[];
  updated_at: string;
}

export interface AppendSessionEventInput {
  actor: SessionActor;
  type: SessionEventType;
  summary: string;
  details?: string;
  expected_revision?: number;
}

export interface AddSessionHandoffInput {
  from?: SessionActor;
  to: SessionActor;
  title: string;
  message: string;
  constraints?: string[];
  expected_output?: string[];
  expected_revision?: number;
}

export interface UpdateSessionHandoffInput {
  actor?: SessionActor;
  status: SessionHandoffStatus;
  result_summary?: string;
  expected_revision?: number;
}

export interface SetSessionGoalInput {
  actor?: SessionActor;
  goal: string;
  phase?: SessionPhase;
  status?: SessionCurrentStatus;
  expected_revision?: number;
}

export interface AppendSessionEvidenceInput {
  actor?: SessionActor;
  kind: SessionEvidenceKind;
  source: SessionEvidenceSource;
  path?: string;
  status: SessionEvidenceStatus;
  purpose?: string;
  metadata?: Record<string, unknown>;
  expected_revision?: number;
}

export interface AppendSessionCheckInput {
  actor?: SessionActor;
  type: SessionCheckType;
  command?: string;
  status: SessionCheckStatus;
  exit_code?: number;
  summary: string;
  duration_ms?: number;
  expected_revision?: number;
}

export interface SessionBootstrapInput {
  actor?: SessionActor;
  client?: SessionBootstrapClient;
  adapter?: SessionBootstrapAdapter;
  source?: string;
  mode?: SessionBootstrapMode;
}

export interface SessionBootstrapResult {
  ok: true;
  project_id: string;
  session_id: string;
  revision: number;
  bootstrapped: true;
  bootstrap_event_created: boolean;
  current_goal: string;
  phase: SessionPhase;
  status: SessionCurrentStatus;
  open_handoffs: SharedSessionHandoff[];
  recent_events: SharedSessionEvent[];
  recent_evidence: SharedSessionEvidence[];
  recent_checks: SharedSessionCheck[];
  active_clients: SharedSessionActiveClient[];
  do_not_do: string[];
  warnings: string[];
  recommended_next_action: SessionRecommendedNextAction;
}

export interface SharedSessionView {
  ok: true;
  active_session: ActiveSessionFile;
  session: SharedSessionFile;
  state: SharedSessionStateFile;
  summary: SharedSessionSummaryFile;
}

export interface SessionUpdatesResult {
  ok: true;
  project_id: string;
  session_id: string;
  from_revision: number;
  to_revision: number;
  events: SharedSessionEvent[];
  handoffs: SharedSessionHandoff[];
  evidence: SharedSessionEvidence[];
  checks: SharedSessionCheck[];
  summary_changed: boolean;
}
