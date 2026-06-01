const REDACTED = "[REDACTED]";

const sensitiveEnvPattern =
  /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PRIVATE|CLIENT_SECRET|AUTH|JWT)[A-Za-z0-9_]*\s*=\s*)(.*)$/gim;

const assignmentPattern =
  /(\b[A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PRIVATE|CLIENT_SECRET|AUTH|JWT)[A-Za-z0-9_]*\b\s*[:=]\s*)(["']?)[^\s"',}]+(\2)/gi;

const privateKeyPattern =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g;
const githubTokenPattern = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
const openAiTokenPattern = /\bsk-[A-Za-z0-9_-]{20,}\b/g;

export function redactSecrets(input: string): string {
  return input
    .replace(privateKeyPattern, REDACTED)
    .replace(sensitiveEnvPattern, `$1${REDACTED}`)
    .replace(assignmentPattern, `$1$2${REDACTED}$3`)
    .replace(bearerPattern, `Bearer ${REDACTED}`)
    .replace(githubTokenPattern, REDACTED)
    .replace(openAiTokenPattern, REDACTED);
}

export function detectRedaction(input: string): boolean {
  return redactSecrets(input) !== input;
}

export function redactAndReport(input: string): { text: string; redacted: boolean } {
  const text = redactSecrets(input);
  return { text, redacted: text !== input };
}
