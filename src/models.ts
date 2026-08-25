import { captureAgyCommand, detectAgy } from "./cli-detect.js";
import { AgyError, AgyProcessError } from "./errors.js";
import { SUPPORTED_EFFORTS, type AgyEffort } from "./constants.js";

export type AgyModel = {
  id: string;
  name: string;
  cliModel: string;
  family?: string;
  effort?: AgyEffort;
  variants?: Record<string, { effort: AgyEffort; cliModel: string }>;
};

export type AgyModelCatalog = {
  models: AgyModel[];
  exactModels: AgyModel[];
  version: string | null;
  executable: string;
  discoveredAt: number;
  source: "cli" | "fallback";
};

export const FALLBACK_MODELS: Array<[string, string]> = [
  ["gemini-3.7-flash-high", "Gemini 3.7 Flash (High)"],
  ["gemini-3.7-flash-medium", "Gemini 3.7 Flash (Medium)"],
  ["gemini-3.7-flash-low", "Gemini 3.7 Flash (Low)"],
  ["gemini-3.6-flash-high", "Gemini 3.6 Flash (High)"],
  ["gemini-3.6-flash-medium", "Gemini 3.6 Flash (Medium)"],
  ["gemini-3.5-flash-medium", "Gemini 3.5 Flash (Medium)"],
  ["gemini-3.1-pro-high", "Gemini 3.1 Pro (High)"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"],
];

const EFFORT_SUFFIX = /^(.*)-(low|medium|high)$/i;

function cleanModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  if (!id || id.length > 200 || /[\s/\\]/.test(id)) return undefined;
  return id;
}

function cleanModelName(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : fallback;
}

function addModel(target: Map<string, string>, id: unknown, name?: unknown): void {
  const clean = cleanModelId(id);
  if (!clean) return;
  target.set(clean, cleanModelName(name, clean));
}

function parseJsonModels(value: unknown, target: Map<string, string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") addModel(target, item);
      else if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        addModel(target, record.id ?? record.slug ?? record.model, record.name ?? record.display_name ?? record.label);
        parseJsonModels(record.models ?? record.data ?? record.items, target);
      }
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of ["models", "data", "items", "available_models", "results"]) {
    if (record[key] !== undefined) parseJsonModels(record[key], target);
  }
  for (const [key, item] of Object.entries(record)) {
    if (["models", "data", "items", "available_models", "results"].includes(key)) continue;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const nested = item as Record<string, unknown>;
      addModel(target, nested.id ?? nested.slug ?? key, nested.name ?? nested.display_name ?? nested.label);
    } else if (typeof item === "string") {
      addModel(target, key, item);
    }
  }
}

/** Parse both the documented JSON shapes and the current `agy models` table. */
export function parseModelOutput(stdout: string): Array<[string, string]> {
  const target = new Map<string, string>();
  const trimmed = stdout.trim();
  const jsonCandidates = [
    trimmed,
    ...[trimmed.indexOf("{"), trimmed.indexOf("[")]
      .filter((index) => index > 0)
      .map((index) => trimmed.slice(index)),
  ];
  for (const candidate of jsonCandidates) {
    try {
      parseJsonModels(JSON.parse(candidate), target);
      if (target.size > 0) return [...target.entries()];
    } catch {
      // Some versions can prefix a warning before the JSON payload. Fall back
      // to line parsing below rather than treating a catalog refresh as fatal.
    }
  }
  for (const line of stdout.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || /^(warning|error|failed|fetching|available models|models:)/i.test(value)) continue;
    const columns = value.split(/\t+/);
    const id = cleanModelId(columns[0]?.split(/\s{2,}/)[0]);
    if (!id || id.toLowerCase() === "model" || id.toLowerCase() === "name") continue;
    const name = columns.length > 1
      ? columns.slice(1).join(" ").trim()
      : value.slice(id.length).trim();
    addModel(target, id, name || id);
  }
  return [...target.entries()];
}

function buildModels(entries: Array<[string, string]>): { exact: AgyModel[]; all: AgyModel[] } {
  const exact = entries.map(([id, name]) => {
    const match = id.match(EFFORT_SUFFIX);
    const effort = match ? (match[2].toLowerCase() as AgyEffort) : undefined;
    return {
      id,
      name,
      cliModel: id,
      ...(match ? { family: match[1], effort } : {}),
    } satisfies AgyModel;
  });
  const families = new Map<string, AgyModel[]>();
  for (const model of exact) {
    if (!model.family || !model.effort) continue;
    const list = families.get(model.family) ?? [];
    list.push(model);
    families.set(model.family, list);
  }
  const aliases: AgyModel[] = [];
  const groupedFamilies = new Set<string>();
  for (const [family, members] of families) {
    if (members.length < 2) continue;
    const variants = Object.fromEntries(
      members
        .filter((member) => member.effort)
        .map((member) => [member.effort!, { effort: member.effort!, cliModel: member.cliModel }]),
    );
    aliases.push({
      id: family,
      name: (members[0].name.replace(/\s*\((?:low|medium|high)\)\s*$/i, "").trim() || family),
      // The CLI accepts the concrete slugs it listed, not necessarily the
      // derived family alias. Use the first listed tier as the default and
      // replace it with an exact sibling when a variant is selected.
      cliModel: members[0].cliModel,
      family,
      variants,
    });
    groupedFamilies.add(family);
  }
  // Effort-suffixed CLI slugs are retained in exactModels for validation and
  // direct API requests, but the OpenCode catalog exposes one named family
  // with variants instead of rendering the same model three or four times.
  const ungroupedExact = exact.filter((model) => !model.family || !groupedFamilies.has(model.family));
  return { exact, all: [...aliases, ...ungroupedExact] };
}

let catalogPromise: Promise<AgyModelCatalog> | null = null;

export async function discoverAgyModels(force = false, cwd?: string): Promise<AgyModelCatalog> {
  if (!force && catalogPromise) return catalogPromise;
  catalogPromise = (async () => {
    const detection = await detectAgy(force);
    let entries: Array<[string, string]> = [];
    let source: "cli" | "fallback" = "cli";
    try {
      // The documented interface currently exposes a text table. Older/newer
      // builds may accept --output-format json, so try it first and fall back.
      const jsonAttempt = await captureAgyCommand(["models", "--output-format", "json"], {
        executable: detection.executable,
        cwd,
        timeoutMs: 60_000,
        maxOutputBytes: 2 * 1024 * 1024,
      });
      entries = parseModelOutput(jsonAttempt.stdout);
      if (jsonAttempt.exitCode !== 0 || entries.length === 0) {
        const textAttempt = await captureAgyCommand(["models"], {
          executable: detection.executable,
          cwd,
          timeoutMs: 60_000,
          maxOutputBytes: 2 * 1024 * 1024,
        });
        entries = parseModelOutput(textAttempt.stdout);
      }
    } catch {
      entries = [];
    }
    if (entries.length === 0) {
      entries = FALLBACK_MODELS;
      source = "fallback";
    }
    const built = buildModels(entries);
    return {
      models: built.all,
      exactModels: built.exact,
      version: detection.version,
      executable: detection.executable,
      discoveredAt: Date.now(),
      source,
    };
  })();
  try {
    return await catalogPromise;
  } catch (error) {
    catalogPromise = null;
    if (error instanceof AgyError) throw error;
    throw new AgyProcessError("Unable to discover agy models", error);
  }
}

export function fallbackAgyModelCatalog(executable = "agy", version: string | null = null): AgyModelCatalog {
  const built = buildModels(FALLBACK_MODELS);
  return {
    models: built.all,
    exactModels: built.exact,
    version,
    executable,
    discoveredAt: Date.now(),
    source: "fallback",
  };
}

export function resetModelCache(): void {
  catalogPromise = null;
}

export type AgyModelSelection = {
  requestedModel: string;
  cliModel: string;
  effort?: AgyEffort;
};

export function resolveAgyModelSelection(
  requestedModel: string | undefined,
  requestedEffort: string | undefined,
  catalog: AgyModelCatalog,
): AgyModelSelection {
  const raw = (requestedModel ?? catalog.models[0]?.id ?? "").replace(/^antigravity-cli\//, "").trim();
  if (!raw) throw new AgyError("unknown_model", "No Antigravity model is available", { code: "agy_no_model" });
  const model = catalog.models.find((entry) => entry.id === raw) ?? catalog.exactModels.find((entry) => entry.id === raw);
  if (!model) {
    throw new AgyError("unknown_model", `Unknown Antigravity model "${raw}"`, {
      code: "agy_unknown_model",
      details: { available: catalog.exactModels.map((entry) => entry.id) },
    });
  }
  const effort = requestedEffort?.trim().toLowerCase();
  if (effort && !(SUPPORTED_EFFORTS as readonly string[]).includes(effort)) {
    throw new AgyError("invalid_request", `Unsupported effort "${requestedEffort}"; use low, medium, or high`, {
      code: "agy_invalid_effort",
    });
  }
  if (!effort) return { requestedModel: raw, cliModel: model.cliModel, ...(model.effort ? { effort: undefined } : {}) };
  const wanted = effort as AgyEffort;
  if (model.variants?.[wanted]) {
    return { requestedModel: raw, cliModel: model.variants[wanted].cliModel };
  }
  if (model.family) {
    const sibling = catalog.exactModels.find((entry) => entry.id === `${model.family}-${wanted}`);
    if (sibling) return { requestedModel: raw, cliModel: sibling.cliModel };
  }
  // For a CLI model without an effort-suffixed sibling, use the documented
  // --effort flag. Exact suffixed slugs are preferred when the CLI listed one.
  return { requestedModel: raw, cliModel: model.cliModel, effort: wanted };
}

export function providerModelEntries(catalog: AgyModelCatalog): AgyModel[] {
  return catalog.models;
}
