import { captureAgyCommand, detectAgy } from "./cli-detect.js";
import { envNumber } from "./constants.js";
import { AgyError, failureFromCliResult } from "./errors.js";

export type AgyQuotaWindow = {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  resetAtFormatted: string | null;
  resetAfterFormatted: string | null;
  valueLabel?: string | null;
};

export type AgyUsageGroup = {
  name: string;
  description?: string;
  windows: Record<string, AgyQuotaWindow>;
};

export type AgyUsageSnapshot = {
  providerId: "antigravity-cli";
  providerName: "Antigravity CLI";
  ok: boolean;
  configured: boolean;
  error?: string;
  cliVersion: string | null;
  fetchedAt: number;
  usage: {
    windows: Record<string, AgyQuotaWindow>;
    models: Record<string, { windows: Record<string, AgyQuotaWindow> }>;
  } | null;
  groups?: AgyUsageGroup[];
};

type UnknownRecord = Record<string, unknown>;

function object(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function timestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1_000_000_000_000 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const whole = Math.max(0, Math.round(seconds));
  const days = Math.floor(whole / 86_400);
  const hours = Math.floor((whole % 86_400) / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function windowSeconds(label: string, value: UnknownRecord): number | null {
  const explicit = number(value.window_seconds ?? value.windowSeconds);
  if (explicit !== null) return explicit;
  if (label === "5h" || /five.?hour/i.test(label)) return 5 * 60 * 60;
  if (label === "weekly" || /week/i.test(label)) return 7 * 24 * 60 * 60;
  return null;
}

function makeWindow(label: string, raw: UnknownRecord): AgyQuotaWindow | null {
  const fraction = number(raw.remaining_fraction ?? raw.remainingFraction);
  const usedFraction = number(raw.used_fraction ?? raw.usedFraction);
  const remainingPercent = fraction === null ? null : Math.max(0, Math.min(100, fraction * 100));
  const usedPercent = usedFraction === null && remainingPercent !== null
    ? Math.max(0, Math.min(100, 100 - remainingPercent))
    : usedFraction === null ? null : Math.max(0, Math.min(100, usedFraction * 100));
  const resetAt = timestamp(raw.reset_time ?? raw.resetAt ?? raw.reset_at);
  const resetAfterSeconds = resetAt === null ? null : Math.max(0, (resetAt - Date.now()) / 1000);
  const explicitLabel = typeof raw.value_label === "string" ? raw.value_label : typeof raw.valueLabel === "string" ? raw.valueLabel : null;
  return {
    usedPercent,
    remainingPercent,
    windowSeconds: windowSeconds(label, raw),
    resetAfterSeconds,
    resetAt,
    resetAtFormatted: resetAt === null ? null : new Date(resetAt).toISOString(),
    resetAfterFormatted: formatDuration(resetAfterSeconds),
    ...(explicitLabel ? { valueLabel: explicitLabel } : {}),
  };
}

function parseGroups(groups: unknown): AgyUsageGroup[] {
  if (!Array.isArray(groups)) return [];
  const result: AgyUsageGroup[] = [];
  for (const item of groups) {
    const group = object(item);
    if (!group || typeof group.name !== "string") continue;
    const windows: Record<string, AgyQuotaWindow> = {};
    if (Array.isArray(group.buckets)) {
      for (const bucket of group.buckets) {
        const raw = object(bucket);
        const label = typeof raw?.window === "string" ? raw.window : typeof raw?.name === "string" ? raw.name : "quota";
        const parsed = raw ? makeWindow(label, raw) : null;
        if (parsed) windows[label] = parsed;
      }
    }
    if (Object.keys(windows).length) result.push({ name: group.name, ...(typeof group.description === "string" ? { description: group.description } : {}), windows });
  }
  return result;
}

export function parseAgyUsageEnvelope(envelope: unknown): AgyUsageSnapshot {
  const root = object(envelope);
  const result: UnknownRecord = root?.result && object(root.result) ? object(root.result)! : root ?? {};
  const command: UnknownRecord | null = object(result.command);
  const data: UnknownRecord | null = command ? object(command.data) : null;
  const groups = parseGroups(data?.groups);
  const windows: Record<string, AgyQuotaWindow> = {};
  const models: Record<string, { windows: Record<string, AgyQuotaWindow> }> = {};
  for (const group of groups) {
    models[group.name] = { windows: group.windows };
    for (const [label, window] of Object.entries(group.windows)) {
      // Keep a top-level value for simple consumers; group-specific windows
      // remain authoritative in `models` and `groups`.
      if (!(label in windows)) windows[label] = window;
    }
  }
  return {
    providerId: "antigravity-cli",
    providerName: "Antigravity CLI",
    ok: String(result?.status ?? "SUCCESS").toUpperCase() === "SUCCESS" && groups.length > 0,
    configured: true,
    ...(groups.length ? {} : { error: "agy /usage returned no quota groups" }),
    cliVersion: null,
    fetchedAt: Date.now(),
    usage: groups.length ? { windows, models } : null,
    ...(groups.length ? { groups } : {}),
  };
}

export function parseAgyUsageText(text: string): AgyUsageSnapshot {
  const groups = new Map<string, AgyUsageGroup>();
  for (const line of text.split(/\r?\n/)) {
    const columns = line.trim().split(/\t+/);
    if (columns.length < 3 || !columns[0] || !columns[1]) continue;
    const groupName = columns[0];
    const label = /five.?hour/i.test(columns[1]) ? "5h" : /weekly/i.test(columns[1]) ? "weekly" : columns[1];
    const percent = Number.parseFloat(columns[2].replace("%", ""));
    if (!Number.isFinite(percent)) continue;
    const resetAt = timestamp(columns[3]);
    const resetAfterSeconds = resetAt === null ? null : Math.max(0, (resetAt - Date.now()) / 1000);
    const window: AgyQuotaWindow = {
      usedPercent: Math.max(0, Math.min(100, 100 - percent)),
      remainingPercent: Math.max(0, Math.min(100, percent)),
      windowSeconds: label === "5h" ? 18_000 : label === "weekly" ? 604_800 : null,
      resetAfterSeconds,
      resetAt,
      resetAtFormatted: resetAt === null ? null : new Date(resetAt).toISOString(),
      resetAfterFormatted: formatDuration(resetAfterSeconds),
    };
    const group = groups.get(groupName) ?? { name: groupName, windows: {} };
    group.windows[label] = window;
    groups.set(groupName, group);
  }
  const parsed = parseAgyUsageEnvelope({ status: "SUCCESS", command: { data: { groups: [...groups.values()].map((group) => ({ name: group.name, buckets: Object.entries(group.windows).map(([window, value]) => ({ window, remaining_fraction: (value.remainingPercent ?? 0) / 100, reset_time: value.resetAt })) })) } } });
  return parsed;
}

let cache: { expiresAt: number; value: AgyUsageSnapshot } | null = null;
let pending: Promise<AgyUsageSnapshot> | null = null;

export async function getAgyUsage(cwd = process.cwd(), force = false): Promise<AgyUsageSnapshot> {
  if (!force && cache && cache.expiresAt > Date.now()) return cache.value;
  if (pending) return pending;
  pending = (async () => {
    try {
      const detection = await detectAgy();
      const output = await captureAgyCommand(["-p", "/usage", "--output-format", "json", "--print-timeout", "60s"], {
        executable: detection.executable,
        cwd,
        timeoutMs: 90_000,
        maxOutputBytes: 512 * 1024,
      });
      const line = output.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
      let envelope: unknown;
      try { envelope = JSON.parse(line); } catch { envelope = null; }
      const failure = envelope && object(envelope) ? failureFromCliResult(envelope as { status?: unknown; error?: unknown; response?: unknown }) : undefined;
      if (failure) throw failure;
      const snapshot = envelope ? parseAgyUsageEnvelope(envelope) : parseAgyUsageText(output.stdout);
      snapshot.cliVersion = detection.version;
      if (output.exitCode !== 0 || !snapshot.ok) throw new AgyError("process", snapshot.error ?? "agy /usage failed", { code: "agy_usage_failed" });
      cache = { expiresAt: Date.now() + envNumber("OPENCODE_AGY_USAGE_CACHE_MS", 30_000, 1_000), value: snapshot };
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to query agy usage";
      const snapshot: AgyUsageSnapshot = { providerId: "antigravity-cli", providerName: "Antigravity CLI", ok: false, configured: true, error: message, cliVersion: null, fetchedAt: Date.now(), usage: null };
      cache = { expiresAt: Date.now() + 5_000, value: snapshot };
      return snapshot;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

export function resetAgyUsageCache(): void {
  cache = null;
}
