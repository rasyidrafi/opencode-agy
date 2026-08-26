export const PROVIDER_ID = "antigravity-cli";
export const PROVIDER_NAME = "Antigravity ACP";
export const ANTHROPIC_NPM = "@ai-sdk/anthropic";

/** A deliberately non-secret value used by the loopback adapter. */
export const LOCAL_API_KEY = "opencode-agy-local";

export const DEFAULT_PRINT_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_TURN_STALL_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_IDLE_WORKER_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_MAX_QUEUE_PER_SESSION = 1;
export const DEFAULT_MAX_SESSIONS = 128;
export const DEFAULT_MAX_STDERR_BYTES = 256 * 1024;
export const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const DEFAULT_REQUEST_READ_TIMEOUT_MS = 30_000;
export const DEFAULT_HISTORY_MAX_CHARS = 100_000;
export const DEFAULT_UTILITY_MAX_CHARS = 24_000;
export const DEFAULT_SSE_HEARTBEAT_MS = 5_000;

export const MODEL_HEADER = "x-opencode-agy-model";
export const EFFORT_HEADER = "x-opencode-agy-effort";
export const SESSION_HEADER = "x-opencode-agy-session";
export const DIRECTORY_HEADER = "x-opencode-agy-directory";
export const REQUEST_TOKEN_HEADER = "x-opencode-agy-token";

export const SUPPORTED_EFFORTS = ["low", "medium", "high"] as const;
export type AcpEffort = (typeof SUPPORTED_EFFORTS)[number];

export function envNumber(name: string, fallback: number, minimum = 0): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

export function envBoolean(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function configuredPrintTimeoutMs(): number {
  return envNumber(
    "OPENCODE_AGY_PRINT_TIMEOUT_MS",
    DEFAULT_PRINT_TIMEOUT_MS,
    1_000,
  );
}

export function configuredTurnStallTimeoutMs(): number {
  return envNumber(
    "OPENCODE_AGY_TURN_STALL_MS",
    DEFAULT_TURN_STALL_TIMEOUT_MS,
    1_000,
  );
}
