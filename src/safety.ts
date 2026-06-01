import crypto from "node:crypto";
import { appendJsonLine, readJsonIfExists, writeJson } from "./fsx.js";
import { bridgePath } from "./paths.js";
import { redactSecrets } from "./redact.js";
import type { ApprovalItem, ApprovalStatus, CommandRisk, RiskLevel } from "./types.js";

const highRiskPatterns: Array<{ pattern: RegExp; reason: string; blocked?: boolean }> = [
  { pattern: /\brm\s+(-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\b/i, reason: "Recursive force delete.", blocked: true },
  { pattern: /\bgit\s+push\b.*\s--force(?:-with-lease)?\b/i, reason: "Force push can rewrite remote history." },
  { pattern: /\bgit\s+reset\b.*\s--hard\b/i, reason: "Hard reset can discard local work." },
  { pattern: /\bgit\s+clean\b.*\s-[^\s]*f[^\s]*d/i, reason: "Git clean can delete untracked files." },
  { pattern: /\bchmod\s+-R\s+777\b/i, reason: "Broad recursive permission change." },
  { pattern: /\bformat\b.*\b(?:disk|volume|drive)\b/i, reason: "Disk formatting command.", blocked: true },
  { pattern: /\bcat\s+.*(?:\.env|id_rsa|id_ed25519)\b/i, reason: "Command may reveal local secrets." },
  { pattern: /\btype\s+.*(?:\.env|id_rsa|id_ed25519)\b/i, reason: "Command may reveal local secrets." }
];

const mediumRiskPatterns: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bgit\s+push\b/i, reason: "Push changes remote state." },
  { pattern: /\brm\b|\bdel\b|\bRemove-Item\b/i, reason: "Delete command." },
  { pattern: /\bcurl\b|\bwget\b|\bInvoke-WebRequest\b/i, reason: "Network command." },
  { pattern: /\bnpm\s+(?:publish|unpublish)\b/i, reason: "Package registry mutation." },
  { pattern: /\bchmod\b|\bicacls\b/i, reason: "Permission change." }
];

const secretFilePattern = /(^|[/\\])(?:\.env(?:\..*)?|id_rsa|id_ed25519|.*\.pem|.*\.key)$/i;
const secretTextPattern =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:KEY|TOKEN|SECRET|PASSWORD|CLIENT_SECRET|AUTH|JWT)\s*[:=]|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})/i;

function rankRisk(current: RiskLevel, next: RiskLevel): RiskLevel {
  const order: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
  return order[next] > order[current] ? next : current;
}

export function classifyCommand(command: string): CommandRisk {
  let risk: RiskLevel = "low";
  let blocked = false;
  const reasons: string[] = [];

  for (const check of highRiskPatterns) {
    if (check.pattern.test(command)) {
      risk = rankRisk(risk, "high");
      blocked = blocked || Boolean(check.blocked);
      reasons.push(check.reason);
    }
  }

  for (const check of mediumRiskPatterns) {
    if (check.pattern.test(command)) {
      risk = rankRisk(risk, "medium");
      reasons.push(check.reason);
    }
  }

  return {
    risk,
    reasons: reasons.length ? [...new Set(reasons)] : ["No known risky pattern detected."],
    requiresApproval: risk !== "low",
    blocked
  };
}

export function isSecretLikePath(filePath: string): boolean {
  return secretFilePattern.test(filePath);
}

export function scanTextForSecrets(text: string): { found: boolean; redacted: string } {
  return {
    found: secretTextPattern.test(text),
    redacted: redactSecrets(text)
  };
}

function approvalsPath(root: string): string {
  return bridgePath(root, "approvals.json");
}

export function listApprovals(root: string, status?: ApprovalStatus): ApprovalItem[] {
  const approvals = readJsonIfExists<ApprovalItem[]>(approvalsPath(root)) ?? [];
  return status ? approvals.filter((item) => item.status === status) : approvals;
}

export function createApproval(
  root: string,
  input: {
    actor?: string;
    action: string;
    command?: string;
    reason?: string;
    risk?: RiskLevel;
  }
): ApprovalItem {
  const now = new Date().toISOString();
  const commandRisk = input.command ? classifyCommand(input.command) : undefined;
  const item: ApprovalItem = {
    id: `appr_${crypto.randomUUID()}`,
    actor: input.actor ?? "codex",
    action: input.action,
    command: input.command ? redactSecrets(input.command) : undefined,
    reason: input.reason ? redactSecrets(input.reason) : undefined,
    risk: input.risk ?? commandRisk?.risk ?? "medium",
    status: "pending",
    created_at: now,
    updated_at: now
  };

  const approvals = listApprovals(root);
  approvals.push(item);
  writeJson(approvalsPath(root), approvals);
  appendJsonLine(bridgePath(root, "approval_queue.jsonl"), item);
  return item;
}

export function resolveApproval(root: string, id: string, status: Extract<ApprovalStatus, "approved" | "rejected">): ApprovalItem {
  const approvals = listApprovals(root);
  const index = approvals.findIndex((item) => item.id === id);
  if (index === -1) {
    throw new Error(`Approval not found: ${id}`);
  }

  approvals[index] = {
    ...approvals[index],
    status,
    updated_at: new Date().toISOString()
  };
  writeJson(approvalsPath(root), approvals);
  appendJsonLine(bridgePath(root, "approval_queue.jsonl"), approvals[index]);
  return approvals[index];
}
