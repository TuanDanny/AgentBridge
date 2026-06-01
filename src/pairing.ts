import qrcode from "qrcode-terminal";
import { readServerInfo } from "./daemonClient.js";
import { ensureLocalToken } from "./auth.js";
import { resolveProjectRoot } from "./paths.js";

export interface PairingInfo {
  dashboardUrl: string;
  token: string;
  warning?: string;
  qr?: string;
}

export function createPairingInfo(rootInput = process.cwd(), options: { host?: string; port?: number; qr?: boolean } = {}): PairingInfo {
  const root = resolveProjectRoot(rootInput);
  const server = readServerInfo(root);
  const host = options.host ?? server?.host ?? "127.0.0.1";
  const port = options.port ?? server?.port ?? 7777;
  const dashboardUrl = `http://${host}:${port}/dashboard`;
  const token = ensureLocalToken(root);
  const warning =
    host === "127.0.0.1" || host === "localhost"
      ? "This URL only works on the current machine. Start with --host 0.0.0.0 and pass --host <LAN_IP> for phone access."
      : undefined;

  return {
    dashboardUrl,
    token,
    warning,
    qr: options.qr ? qrString(dashboardUrl) : undefined
  };
}

function qrString(value: string): string {
  let output = "";
  qrcode.generate(value, { small: true }, (qr) => {
    output = qr;
  });
  return output;
}
