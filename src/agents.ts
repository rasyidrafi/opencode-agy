import { captureAgyCommand, detectAgy } from "./cli-detect.js";

export type AgyAgent = { id: string; name: string };

let agentsPromise: Promise<AgyAgent[]> | null = null;

export function parseAgentOutput(stdout: string): AgyAgent[] {
  const result: AgyAgent[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || /^(available agents|agents:|no agents)/i.test(value)) continue;
    const columns = value.split(/\t+/);
    const id = columns[0]?.trim();
    if (!id || /\s/.test(id) || id.length > 200 || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, name: columns.slice(1).join(" ").trim() || id });
  }
  return result;
}

export async function discoverAgyAgents(force = false, cwd?: string): Promise<AgyAgent[]> {
  if (!force && agentsPromise) return agentsPromise;
  agentsPromise = (async () => {
    const detection = await detectAgy(force);
    const result = await captureAgyCommand(["agents"], {
      executable: detection.executable,
      cwd,
      timeoutMs: 30_000,
      maxOutputBytes: 512 * 1024,
    });
    return result.exitCode === 0 ? parseAgentOutput(result.stdout) : [];
  })();
  try {
    return await agentsPromise;
  } catch (error) {
    agentsPromise = null;
    throw error;
  }
}

export function resetAgentCache(): void {
  agentsPromise = null;
}
