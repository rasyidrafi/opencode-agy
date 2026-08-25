import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgyWorker, type AgyWorker } from "./cli-process.js";
import { AgyAbortError, AgyBusyError, AgyError, AgyProcessError } from "./errors.js";
import { DEFAULT_MAX_NDJSON_LINE_BYTES, envNumber } from "./constants.js";
import type { AgyEvent } from "./protocol.js";
import type { SessionSettings } from "./session-pool.js";
import { debug, info, warn } from "./log.js";

type JsonRecord = Record<string, unknown>;

export type HostTool = {
  type?: unknown;
  function?: {
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
  };
};

export type BridgeTool = {
  originalName: string;
  mcpName: string;
  description: string;
  parameters: JsonRecord;
};

export type BridgeCall = {
  id: string;
  name: string;
  arguments: string;
};

export type BridgeEvent =
  | { kind: "agy"; event: AgyEvent }
  | { kind: "tool_call"; call: BridgeCall };

type PendingCall = {
  call: BridgeCall;
  resolve: (value: string) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type QueueWaiter<T> = {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  abort?: () => void;
};

class CallQueue<T> {
  private values: T[] = [];
  private waiters: QueueWaiter<T>[] = [];
  private closed = false;
  private closeError: unknown;

  constructor(private readonly max = 64) {}

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.abort?.();
      waiter.resolve(value);
      return;
    }
    if (this.values.length >= this.max) {
      this.close(new AgyProcessError("The agy tool bridge produced too many pending calls"));
      return;
    }
    this.values.push(value);
  }

  next(signal?: AbortSignal): Promise<T> {
    if (this.values.length) return Promise.resolve(this.values.shift()!);
    if (this.closed) return Promise.reject(this.closeError ?? new AgyProcessError("The agy tool bridge is closed"));
    return new Promise<T>((resolve, reject) => {
      const waiter: QueueWaiter<T> = { resolve, reject };
      const remove = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
      };
      if (signal) {
        const onAbort = () => {
          remove();
          reject(new AgyAbortError("The agy tool bridge request was cancelled"));
        };
        waiter.abort = () => signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  close(error?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.abort?.();
      waiter.reject(error ?? new AgyProcessError("The agy tool bridge is closed"));
    }
    this.values = [];
  }
}

function stringValue(value: unknown, fallback: string, max: number): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

function safeToolName(name: string, index: number): string {
  const slug = name.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 80) || "tool";
  return `opencode_${index}_${slug}`;
}

export function normalizeBridgeTools(input: unknown): BridgeTool[] {
  if (!Array.isArray(input)) return [];
  if (input.length > 64) throw new AgyError("unsupported", "The opt-in agy tool bridge accepts at most 64 tools", { code: "agy_bridge_tool_limit" });
  const result: BridgeTool[] = [];
  const names = new Set<string>();
  for (const [index, item] of input.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const tool = item as HostTool;
    if (tool.type !== undefined && tool.type !== "function") continue;
    const fn = tool.function;
    const name = stringValue(fn?.name, "", 160);
    if (!name || names.has(name) || !/^[A-Za-z0-9_.:-]+$/.test(name)) continue;
    names.add(name);
    const parameters = fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)
      ? fn.parameters as JsonRecord
      : { type: "object", properties: {} };
    const serialized = JSON.stringify(parameters);
    result.push({
      originalName: name,
      // Keep the host's function name when it is already a valid MCP name so
      // the follow-up OpenAI tool result can be correlated without aliases.
      mcpName: /^[A-Za-z0-9_.:-]+$/.test(name) ? name : safeToolName(name, index),
      description: stringValue(fn?.description, name, 4_000),
      parameters: serialized.length <= DEFAULT_MAX_NDJSON_LINE_BYTES ? parameters : { type: "object", properties: {} },
    });
  }
  return result;
}

function bridgeScriptPath(): string {
  return process.env.OPENCODE_AGY_MCP_BRIDGE_SCRIPT?.trim() || fileURLToPath(new URL("./mcp-bridge.js", import.meta.url));
}

function mcpList(tools: BridgeTool[]): JsonRecord[] {
  return tools.map((tool) => ({ name: tool.mcpName, description: tool.description, inputSchema: tool.parameters }));
}

export class BridgeSession {
  readonly id = randomUUID();
  readonly token = randomUUID();
  readonly tools: BridgeTool[];
  readonly createdAt = Date.now();
  private readonly calls = new CallQueue<BridgeCall>();
  private readonly pending = new Map<string, PendingCall>();
  private overlayDirectory: string | undefined;
  private closed = false;

  constructor(tools: BridgeTool[]) {
    this.tools = tools;
  }

  get overlay(): string | undefined {
    return this.overlayDirectory;
  }

  async prepare(endpoint: string): Promise<string> {
    if (this.closed) throw new AgyProcessError("The agy tool bridge session is closed");
    const script = bridgeScriptPath();
    try {
      await access(script);
    } catch (error) {
      throw new AgyProcessError("The built agy MCP bridge executable is unavailable", error);
    }
    const overlay = await mkdtemp(join(tmpdir(), "opencode-agy-bridge-"));
    try {
      await chmod(overlay, 0o700).catch(() => undefined);
      const name = `opencode-agy-${this.id.slice(0, 12)}`;
      const agentsDirectory = join(overlay, ".agents");
      await mkdir(agentsDirectory, { recursive: true, mode: 0o700 });
      const configPath = join(agentsDirectory, "mcp_config.json");
      const config = {
        mcpServers: {
          [name]: {
            command: process.execPath,
            args: [script, "--bridge-id", this.id],
            env: {
              OPENCODE_AGY_BRIDGE_URL: endpoint,
            },
          },
        },
      };
      await writeFile(configPath, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
      await chmod(configPath, 0o600).catch(() => undefined);
      // Do not call `agy mcp add` here. The current CLI's command writes the
      // user's global MCP registry even when cwd is a temporary overlay. The
      // documented workspace config is the only safe mutation boundary.
      this.overlayDirectory = overlay;
      info("prepared opt-in agy MCP bridge", { tools: this.tools.length, overlay });
      return overlay;
    } catch (error) {
      await rm(overlay, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async nextCall(signal?: AbortSignal): Promise<BridgeCall> {
    return this.calls.next(signal);
  }

  async call(mcpName: string, args: unknown): Promise<string> {
    if (this.closed) throw new AgyProcessError("The agy tool bridge session is closed");
    const tool = this.tools.find((entry) => entry.mcpName === mcpName);
    if (!tool) throw new AgyError("unsupported", `The agy requested an unknown bridged tool "${mcpName}"`, { code: "agy_bridge_unknown_tool" });
    const serialized = JSON.stringify(args && typeof args === "object" ? args : {});
    if (serialized.length > 256 * 1024) throw new AgyError("unsupported", "Bridged tool arguments exceed the safety limit", { code: "agy_bridge_arguments_too_large" });
    const id = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const call: BridgeCall = { id, name: tool.originalName, arguments: serialized };
    const timeoutMs = envNumber("OPENCODE_AGY_BRIDGE_CALL_TIMEOUT_MS", 10 * 60_000, 1_000);
    const result = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgyError("timeout", `The bridged OpenCode tool "${tool.originalName}" timed out`, { code: "agy_bridge_tool_timeout" }));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { call, resolve, reject, timer });
    });
    this.calls.push(call);
    info("agy requested a bridged OpenCode tool", { tool: tool.originalName });
    return result;
  }

  resolve(id: string, value: string, error?: string): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(new AgyError("process", error, { code: "agy_bridge_tool_error" }));
    else pending.resolve(value.slice(0, 512 * 1024));
    info("resolved bridged OpenCode tool", { tool: pending.call.name });
    return true;
  }

  async rpc(message: JsonRecord): Promise<JsonRecord> {
    const id = message.id;
    const method = message.method;
    debug("received MCP bridge request", { method: typeof method === "string" ? method : "unknown" });
    if (method === "server/discover") {
      // Antigravity sends this capability probe before standard MCP
      // initialize. It accepts an empty discovery result; returning a JSON-RPC
      // method-not-found error makes the CLI cancel the server connection.
      return { jsonrpc: "2.0", id, result: {} };
    }
    if (method === "initialize") {
      return { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "opencode-agy", version: "0.1.0" } } };
    }
    if (method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: mcpList(this.tools) } };
    }
    if (method === "tools/call") {
      const params = message.params && typeof message.params === "object" ? message.params as JsonRecord : {};
      try {
        const text = await this.call(String(params.name ?? ""), params.arguments);
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "Bridged tool failed";
        return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: messageText }] } };
      }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported MCP method ${String(method)}` } };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.calls.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AgyProcessError("The agy tool bridge session was closed"));
    }
    this.pending.clear();
    if (this.overlayDirectory && process.env.OPENCODE_AGY_BRIDGE_KEEP_TEMP !== "1") await rm(this.overlayDirectory, { recursive: true, force: true }).catch(() => undefined);
    this.overlayDirectory = undefined;
  }
}

export class BridgeTurn {
  private readonly iterator: AsyncIterator<AgyEvent>;
  private workerNext: Promise<IteratorResult<AgyEvent>> | undefined;
  private parked = false;
  private done = false;
  private closed = false;

  constructor(readonly bridge: BridgeSession, readonly worker: AgyWorker, readonly prompt: string, readonly signal?: AbortSignal) {
    this.iterator = worker.runTurn(prompt, signal)[Symbol.asyncIterator]();
  }

  private nextWorker(): Promise<IteratorResult<AgyEvent>> {
    if (!this.workerNext) {
      const promise = this.iterator.next();
      let wrapped!: Promise<IteratorResult<AgyEvent>>;
      wrapped = promise.then((result) => {
        if (this.workerNext === wrapped) this.workerNext = undefined;
        return result;
      });
      this.workerNext = wrapped;
    }
    return this.workerNext;
  }

  async *events(signal?: AbortSignal): AsyncGenerator<BridgeEvent> {
    this.parked = false;
    const callController = new AbortController();
    const combined = signal ? AbortSignal.any([signal, callController.signal]) : callController.signal;
    const callPromise = this.bridge.nextCall(combined).then((call) => ({ kind: "call" as const, call }));
    try {
      while (true) {
        const workerPromise = this.nextWorker().then((value) => ({ kind: "agy" as const, value }));
        const result = await Promise.race([workerPromise, callPromise]);
        if (result.kind === "call") {
          this.parked = true;
          yield { kind: "tool_call", call: result.call };
          return;
        }
        if (result.value.done) {
          this.done = true;
          return;
        }
        const event = result.value.value;
        yield { kind: "agy", event };
        if (event.event === "result") {
          this.done = true;
          return;
        }
      }
    } finally {
      callController.abort();
      if (!this.parked && !this.done && !this.closed) await this.close();
    }
  }

  async finish(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.iterator.return?.(); } catch { /* worker shutdown below */ }
    await this.worker.stop(true).catch(() => undefined);
    await this.bridge.close();
  }
}

export class BridgePool {
  private turns = new Map<string, BridgeTurn>();

  get(key: string): BridgeTurn | undefined {
    return this.turns.get(key);
  }

  async start(key: string, prompt: string, settings: SessionSettings, tools: HostTool[], endpoint: string, signal?: AbortSignal): Promise<BridgeTurn> {
    if (this.turns.has(key)) throw new AgyBusyError("A bridged Antigravity turn is already waiting for OpenCode tool results");
    const normalized = normalizeBridgeTools(tools);
    if (!normalized.length) throw new AgyError("unsupported", "No usable OpenCode tools were supplied for the opt-in bridge", { code: "agy_bridge_no_tools" });
    const bridge = new BridgeSession(normalized);
    let worker: AgyWorker | undefined;
    try {
      const executable = settings.executable;
      if (!executable) throw new AgyProcessError("The agy executable is required for the opt-in bridge");
      const overlay = await bridge.prepare(endpoint);
      worker = await createAgyWorker({
        cwd: settings.cwd,
        executable,
        model: settings.model,
        effort: settings.effort,
        agent: settings.agent,
        mode: settings.mode,
        sandbox: settings.sandbox,
        dangerouslySkipPermissions: settings.dangerouslySkipPermissions,
        addDirs: [overlay],
        environment: { OPENCODE_AGY_BRIDGE_TOKEN: bridge.token },
      }, signal);
      const turn = new BridgeTurn(bridge, worker, prompt, signal);
      this.turns.set(key, turn);
      return turn;
    } catch (error) {
      await worker?.stop(true).catch(() => undefined);
      await bridge.close();
      throw error;
    }
  }

  resolve(key: string, id: string, value: string, error?: string): boolean {
    return this.turns.get(key)?.bridge.resolve(id, value, error) ?? false;
  }

  async finish(key: string, turn: BridgeTurn): Promise<void> {
    if (this.turns.get(key) === turn) this.turns.delete(key);
    await turn.finish();
  }

  async close(): Promise<void> {
    const turns = [...this.turns.values()];
    this.turns.clear();
    await Promise.all(turns.map((turn) => turn.close()));
  }

  async rpc(bridgeId: string, token: string, message: JsonRecord): Promise<JsonRecord> {
    const turn = [...this.turns.values()].find((candidate) => candidate.bridge.id === bridgeId);
    if (!turn || turn.bridge.token !== token) throw new AgyError("auth", "Invalid agy bridge token", { code: "agy_bridge_auth" });
    return turn.bridge.rpc(message);
  }
}

export const bridgePool = new BridgePool();
