const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, "$1[REDACTED]"],
  [/("?(?:access_token|refresh_token|id_token|access|refresh|client_secret)"?\s*[:=]\s*")([^"]+)(")/g, "$1[REDACTED]$3"],
  [/((?:access_token|refresh_token|id_token|client_secret)=)[^&\s]+/g, "$1[REDACTED]"],
  [/(ya29\.)[A-Za-z0-9._~+/=-]+/g, "$1[REDACTED]"],
  [/(1\/\/)[A-Za-z0-9._~+/=-]+/g, "$1[REDACTED]"],
  [/(GOCSPX-)[A-Za-z0-9_-]+/g, "$1[REDACTED]"],
  [/(AIza)[A-Za-z0-9_-]{10,}/g, "$1[REDACTED]"],
];

/** Redact anything token-shaped from a string. Used for every log line and error echo. */
export function redactSecrets(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Debug logger. Off unless OPENCODE_GOOGLE_DEBUG=1 (or config.debug). Writes to stderr only. */
export class DebugLog {
  constructor(private readonly enabled: boolean) {}

  log(...parts: unknown[]): void {
    if (!this.enabled) return;
    const line = parts
      .map((part) => {
        if (typeof part === "string") return part;
        if (part instanceof Error) return `${part.name}: ${part.message}`;
        try {
          return JSON.stringify(part);
        } catch {
          return String(part);
        }
      })
      .join(" ");
    process.stderr.write(`[ogac] ${redactSecrets(line)}\n`);
  }
}
