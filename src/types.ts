export const BRIDGE_DIR = ".agentbridge";

export type CaptureMode = "short" | "full" | "raw";

export interface AgentBridgeSession {
  session_id: string;
  project_root: string;
  project_name: string;
  status:
    | "initialized"
    | "captured"
    | "planning"
    | "prompt_ready"
    | "codex_working"
    | "result_ready"
    | "review_ready";
  user_goal: string;
  active_branch: string;
  chatgpt_plan_status: "missing" | "draft" | "ready";
  codex_task_status: "missing" | "waiting" | "ready" | "working" | "submitted";
  last_test_status: "unknown" | "passed" | "failed" | "not_run";
  next_action: string;
  created_at: string;
  updated_at: string;
}

export interface GitInfo {
  available: boolean;
  branch: string;
  status: string;
  changedFiles: string[];
  diffStat: string;
  diff: string;
  recentCommits: string;
  error?: string;
}

export interface CommandResult {
  bridgeDir: string;
  message: string;
  changedFiles: string[];
}

export interface AuditEvent {
  timestamp: string;
  action: string;
  details: Record<string, unknown>;
}

export interface ServerInfo {
  host: string;
  port: number;
  pid: number;
  project_root: string;
  bridge_dir: string;
  started_at: string;
}

export interface ServerOptions {
  host: string;
  port: number;
}

export type RiskLevel = "low" | "medium" | "high";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface CommandRisk {
  risk: RiskLevel;
  reasons: string[];
  requiresApproval: boolean;
  blocked: boolean;
}

export interface ApprovalItem {
  id: string;
  actor: string;
  action: string;
  command?: string;
  reason?: string;
  risk: RiskLevel;
  status: ApprovalStatus;
  created_at: string;
  updated_at: string;
}
