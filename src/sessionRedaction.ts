import { redactSecrets as redactBaseSecrets } from "./redact.js";

export interface SanitizedSessionText {
  text: string;
  redacted: boolean;
  truncated: boolean;
}

export function redactSecrets(input: string): string {
  return redactBaseSecrets(input);
}

export function sanitizeSessionText(input: unknown, maxChars: number): SanitizedSessionText {
  const raw = typeof input === "string" ? input : input === undefined || input === null ? "" : String(input);
  const redactedText = redactSessionAssignments(redactBaseSecrets(raw)).replace(/\r\n/g, "\n");
  const truncated = redactedText.length > maxChars;
  return {
    text: truncated ? redactedText.slice(0, maxChars) : redactedText,
    redacted: redactedText !== raw,
    truncated
  };
}

function redactSessionAssignments(input: string): string {
  return input
    .replace(
      /\b(?:[A-Za-z_][A-Za-z0-9_]*?(?:KEY|TOKEN|SECRET|PASSWORD|PRIVATE|CLIENT_SECRET|AUTH|JWT)[A-Za-z0-9_]*|KEY|TOKEN|SECRET|PASSWORD|PRIVATE|CLIENT_SECRET|AUTH|JWT)\s*[:=]\s*(?:"?\[REDACTED\]"?)/gim,
      "[REDACTED]"
    )
    .replace(/^\s*(?:export\s+)?\[REDACTED\]\s*$/gim, "[REDACTED]");
}

export function sanitizeSessionTextArray(input: unknown, maxItems: number, maxChars: number): {
  values: string[];
  redacted: boolean;
  truncated: boolean;
} {
  const source = Array.isArray(input) ? input : [];
  const values: string[] = [];
  let redacted = false;
  let truncated = source.length > maxItems;

  for (const item of source.slice(0, maxItems)) {
    const sanitized = sanitizeSessionText(item, maxChars);
    if (sanitized.text.trim()) {
      values.push(sanitized.text.trim());
    }
    redacted = redacted || sanitized.redacted;
    truncated = truncated || sanitized.truncated;
  }

  return { values, redacted, truncated };
}
