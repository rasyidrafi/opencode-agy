export const PROVIDER_ID = "antigravity-cli";
export const PROVIDER_NAME = "Antigravity CLI";
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

/** A deliberately non-secret value used by the loopback OpenAI adapter. */
export const LOCAL_API_KEY = "opencode-agy-local";

export const AGY_VERSION_MINIMUM = "1.1.8";
export const DEFAULT_PRINT_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_TURN_STALL_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_IDLE_WORKER_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_MAX_QUEUE_PER_SESSION = 1;
export const DEFAULT_MAX_SESSIONS = 128;
export const DEFAULT_MAX_NDJSON_LINE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_STDERR_BYTES = 256 * 1024;
export const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const DEFAULT_REQUEST_READ_TIMEOUT_MS = 30_000;
export const DEFAULT_HISTORY_MAX_CHARS = 100_000;
export const DEFAULT_UTILITY_MAX_CHARS = 24_000;
export const DEFAULT_SSE_HEARTBEAT_MS = 5_000;

export const MODEL_HEADER = "x-opencode-agy-model";
export const EFFORT_HEADER = "x-opencode-agy-effort";
export const AGENT_HEADER = "x-opencode-agy-agent";
export const OPENCODE_AGENT_HEADER = "x-opencode-agy-opencode-agent";
export const SESSION_HEADER = "x-opencode-agy-session";
export const DIRECTORY_HEADER = "x-opencode-agy-directory";
export const REQUEST_TOKEN_HEADER = "x-opencode-agy-token";

export const SUPPORTED_EFFORTS = ["low", "medium", "high"] as const;
export type AgyEffort = (typeof SUPPORTED_EFFORTS)[number];

export type AgyExecutionMode = "accept-edits" | "plan";

/** Explore is a read-only OpenCode agent, so keep its CLI worker read-only. */
export function modeForOpenCodeAgent(
  openCodeAgent: string | undefined,
  configuredMode: string | undefined,
): AgyExecutionMode | undefined {
  if (openCodeAgent?.trim().toLowerCase() === "explore") return "plan";
  if (configuredMode === "accept-edits" || configuredMode === "plan") return configuredMode;
  return undefined;
}

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
