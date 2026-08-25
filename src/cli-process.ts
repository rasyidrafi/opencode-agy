import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { AgyAbortError, AgyProcessError, AgyError, AgyProtocolError, AgyTimeoutError, classifyAgyText, type AgyFailureKind } from "./errors.js";
import {
  DEFAULT_MAX_NDJSON_LINE_BYTES,
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_PRINT_TIMEOUT_MS,
  configuredPrintTimeoutMs,
  configuredTurnStallTimeoutMs,
  type AgyEffort,
} from "./constants.js";
import { detectAgy, isWindowsCommandShim, resolveAgyExecutable, terminateAgyProcess } from "./cli-detect.js";
import { debug, info, warn } from "./log.js";
import {
  encodeUserEvent,
  NdjsonFramer,
  parseNdjsonLine,
  resultConversationId,
  type AgyEvent,
  type TextBlock,
} from "./protocol.js";

export type AgyWorkerState = "created" | "starting" | "ready" | "turn_active" | "closing" | "closed" | "failed";

export type AgyWorkerOptions = {
  cwd: string;
  executable?: string;
  addDirs?: string[];
  environment?: Record<string, string | undefined>;
  model?: string;
  effort?: AgyEffort;
  agent?: string;
  conversationId?: string;
  mode?: "accept-edits" | "plan";
  sandbox?: boolean;
  printTimeoutMs?: number;
  stallTimeoutMs?: number;
  maxLineBytes?: number;
};

type QueueWaiter<T> = {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  abort?: () => void;
};

class AsyncEventQueue<T> {
  private values: T[] = [];
  private waiters: QueueWaiter<T>[] = [];
  private closed = false;
  private closeError: unknown;

  constructor(private readonly maxValues = 1_024) {}

  private cleanupWaiter(waiter: QueueWaiter<T>): void {
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.abort?.();
  }

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      this.cleanupWaiter(waiter);
      waiter.resolve({ done: false, value });
    } else if (this.values.length < this.maxValues) {
      this.values.push(value);
    } else {
      this.close(new AgyProtocolError("agy produced too many unread protocol events"));
    }
  }

  close(error?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      this.cleanupWaiter(waiter);
      if (error) waiter.reject(error);
      else waiter.resolve({ done: true, value: undefined as never });
    }
  }

  next(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<IteratorResult<T>> {
    if (this.values.length) return Promise.resolve({ done: false, value: this.values.shift()! });
    if (this.closed) return this.closeError ? Promise.reject(this.closeError) : Promise.resolve({ done: true, value: undefined as never });
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      const waiter: QueueWaiter<T> = { resolve, reject };
      const remove = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
      };
      if (options.timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          remove();
          this.cleanupWaiter(waiter);
          reject(new AgyTimeoutError(`The agy process produced no output for ${Math.ceil(options.timeoutMs! / 1000)} seconds`));
        }, options.timeoutMs);
        waiter.timer.unref?.();
      }
      if (options.signal) {
        const onAbort = () => {
          remove();
          this.cleanupWaiter(waiter);
          reject(new AgyAbortError());
        };
        waiter.abort = () => options.signal?.removeEventListener("abort", onAbort);
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  get size(): number {
    return this.values.length;
  }
}

function formatDuration(ms: number): string {
  return `${Math.max(1, Math.ceil(ms / 1_000))}s`;
}

function safeFlagValue(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.:@+\-]+$/.test(value) || value.length > 300) {
    throw new AgyProcessError(`Invalid ${label} value for the agy CLI`);
  }
  return value;
}

function buildArgs(options: AgyWorkerOptions): string[] {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
  for (const directory of options.addDirs ?? []) {
    if (!directory || directory.length > 8_000) throw new AgyProcessError("Invalid agy additional workspace directory");
    args.push("--add-dir", directory);
  }
  if (options.model) args.push("--model", safeFlagValue(options.model, "model"));
  if (options.effort) args.push("--effort", options.effort);
  if (options.agent) args.push("--agent", safeFlagValue(options.agent, "agent"));
  if (options.conversationId) args.push("--conversation", safeFlagValue(options.conversationId, "conversation"));
  if (options.mode) args.push("--mode", options.mode);
  if (options.sandbox) args.push("--sandbox");
  // The headless stream-json protocol cannot service interactive permission
  // prompts. Every plugin-launched worker therefore runs with the explicit
  // dangerous-permissions flag, regardless of its workflow mode.
  args.push("--dangerously-skip-permissions");
  args.push("--print-timeout", formatDuration(options.printTimeoutMs ?? DEFAULT_PRINT_TIMEOUT_MS));
  return args;
}

function errorForProcessExit(code: number | null, signal: NodeJS.Signals | null, stderrBytes: number, resumeAttempted: boolean, stderr: string): AgyError {
  if (resumeAttempted && /no conversation|conversation .*not found|session .*not found|could not (?:find|load|resume)/i.test(stderr)) {
    return new AgyProcessError("The saved Antigravity conversation could not be resumed", undefined);
  }
  const diagnosticKind = classifyAgyText(stderr);
  if (diagnosticKind === "auth" || diagnosticKind === "quota" || diagnosticKind === "timeout" || diagnosticKind === "unknown_model") {
    const messages: Record<Extract<AgyFailureKind, "auth" | "quota" | "timeout" | "unknown_model">, string> = {
      auth: "The official agy CLI requires authentication",
      quota: "The official agy CLI reported a quota or rate-limit failure",
      timeout: "The official agy CLI timed out",
      unknown_model: "The official agy CLI rejected the selected model",
    };
    return new AgyError(diagnosticKind, messages[diagnosticKind], { code: `agy_${diagnosticKind}` });
  }
  const suffix = signal ? ` after signal ${signal}` : ` with exit code ${code ?? "unknown"}`;
  return new AgyProcessError(`The agy process exited${suffix} before completing the protocol (${stderrBytes} diagnostic bytes)`);
}

export class AgyWorker {
  readonly options: AgyWorkerOptions;
  readonly executable: string;
  readonly startedAt = Date.now();
  private child: ChildProcess | null = null;
  private events = new AsyncEventQueue<AgyEvent>();
  private stateValue: AgyWorkerState = "created";
  private initEvent: Extract<AgyEvent, { event: "init" }> | null = null;
  private conversationIdValue: string | undefined;
  private stderrBytesValue = 0;
  private stderrDiagnostic = "";
  private framer: NdjsonFramer;
  private decoder = new StringDecoder("utf8");
  private stopping = false;
  private activeTurn = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: AgyWorkerOptions, executable: string) {
    this.options = { ...options };
    this.executable = executable;
    this.framer = new NdjsonFramer(options.maxLineBytes ?? DEFAULT_MAX_NDJSON_LINE_BYTES);
    this.conversationIdValue = options.conversationId;
  }

  get state(): AgyWorkerState {
    return this.stateValue;
  }

  get conversationId(): string | undefined {
    return this.conversationIdValue;
  }

  get init(): Extract<AgyEvent, { event: "init" }> | null {
    return this.initEvent;
  }

  get stderrBytes(): number {
    return this.stderrBytesValue;
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.stateValue === "ready") return;
    if (this.stateValue !== "created") throw new AgyProcessError(`Cannot start agy worker from state ${this.stateValue}`);
    this.stateValue = "starting";
    try {
      this.child = spawn(this.executable, buildArgs(this.options), {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.environment },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
        shell: isWindowsCommandShim(this.executable),
      });
    } catch (error) {
      this.stateValue = "failed";
      throw new AgyProcessError("Failed to spawn the official agy process", error);
    }
    const child = this.child;
    child.stdout?.on("data", (chunk: Buffer | string) => this.onStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.stderrBytesValue = Math.min(DEFAULT_MAX_STDERR_BYTES, this.stderrBytesValue + Buffer.byteLength(chunk));
      if (this.stderrDiagnostic.length < 16 * 1024) {
        this.stderrDiagnostic += (typeof chunk === "string" ? chunk : chunk.toString("utf8")).slice(0, 16 * 1024 - this.stderrDiagnostic.length);
      }
      // stderr is deliberately counted but never logged: it may contain
      // prompts, account details, paths, or credential diagnostics.
    });
    child.once("error", (error) => {
      if (!this.stopping) {
        this.stateValue = "failed";
        this.events.close(new AgyProcessError("The agy process emitted a spawn error", error));
      }
    });
    child.once("close", (code, signalName) => {
      const finalChunk = this.decoder.end();
      try {
        for (const line of this.framer.push(finalChunk)) this.pushLine(line);
        for (const line of this.framer.finish()) this.pushLine(line);
      } catch (error) {
        this.stateValue = "failed";
        this.events.close(error);
        return;
      }
      if (this.stopping || this.stateValue === "closing" || this.stateValue === "closed") {
        this.stateValue = "closed";
        this.events.close();
      } else {
        this.stateValue = "failed";
        this.events.close(errorForProcessExit(code, signalName, this.stderrBytesValue, Boolean(this.options.conversationId), this.stderrDiagnostic));
      }
    });

    try {
      const first = await this.events.next({ timeoutMs: this.options.printTimeoutMs ?? DEFAULT_PRINT_TIMEOUT_MS, signal });
      if (first.done) throw new AgyProcessError("The agy process closed before its init event");
      if (first.value.event !== "init") throw new AgyProtocolError("The agy process did not begin with an init event");
      if (this.options.conversationId && first.value.conversation_id && first.value.conversation_id !== this.options.conversationId) {
        throw new AgyError("process", "The saved Antigravity conversation could not be resumed", { code: "agy_conversation_resume_failed", retryable: false });
      }
      this.initEvent = first.value;
      this.conversationIdValue = first.value.conversation_id ?? this.conversationIdValue;
      this.stateValue = "ready";
      info("agy worker ready", { state: this.stateValue, hasConversation: Boolean(this.conversationIdValue) });
    } catch (error) {
      await this.stop(true);
      this.stateValue = "failed";
      throw error;
    }
  }

  private onStdout(chunk: Buffer | string): void {
    if (this.stateValue === "closed") return;
    try {
      const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
      for (const line of this.framer.push(text)) this.pushLine(line);
    } catch (error) {
      this.stateValue = "failed";
      this.events.close(error instanceof AgyProtocolError ? error : new AgyProtocolError("Could not parse agy stdout", error));
      if (this.child) terminateAgyProcess(this.child, true);
    }
  }

  private pushLine(line: string): void {
    const event = parseNdjsonLine(line, this.options.maxLineBytes ?? DEFAULT_MAX_NDJSON_LINE_BYTES);
    const conversationId = resultConversationId(event);
    if (conversationId) this.conversationIdValue = conversationId;
    this.events.push(event);
  }

  private async writeLine(line: string, signal?: AbortSignal): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) throw new AgyProcessError("The agy stdin pipe is not writable");
    if (signal?.aborted) throw new AgyAbortError();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        stdin.off("error", onError);
        this.child?.off("close", onClose);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onError = (error: Error) => finish(new AgyProcessError("The agy stdin pipe failed", error));
      const onAbort = () => finish(new AgyAbortError());
      const onClose = () => finish(new AgyProcessError("The agy process closed while writing a prompt"));
      stdin.once("error", onError);
      this.child?.once("close", onClose);
      signal?.addEventListener("abort", onAbort, { once: true });
      const accepted = stdin.write(`${line}\n`, "utf8");
      // A true return value means the stream accepted the bytes immediately;
      // a false value requires waiting for drain before sending another line.
      if (accepted) finish();
      if (!accepted) stdin.once("drain", () => finish());
    });
  }

  async *runTurn(content: string | TextBlock[], signal?: AbortSignal): AsyncGenerator<AgyEvent> {
    if (this.stateValue !== "ready") throw new AgyProcessError(`Cannot run an agy turn from state ${this.stateValue}`);
    if (this.activeTurn) throw new AgyProcessError("The agy worker already has an active turn");
    this.activeTurn = true;
    this.stateValue = "turn_active";
    let receivedResult = false;
    try {
      await this.writeLine(encodeUserEvent(content), signal);
      while (true) {
        const next = await this.events.next({
          timeoutMs: this.options.stallTimeoutMs ?? configuredTurnStallTimeoutMs(),
          signal,
        });
        if (next.done) throw new AgyProcessError("The agy process ended before returning a result");
        const event = next.value;
        if (event.event === "init") continue;
        yield event;
        if (event.event === "result") {
          receivedResult = true;
          break;
        }
      }
      this.stateValue = "ready";
    } catch (error) {
      // A cancelled or ambiguous turn cannot safely be left in a persistent
      // worker. Stop it and make the caller start a fresh/resumed worker next.
      if (!receivedResult) await this.stop(true);
      throw error;
    } finally {
      if (!receivedResult) {
        await this.stop(true);
      }
      this.activeTurn = false;
      if (this.stateValue === "turn_active") this.stateValue = receivedResult ? "ready" : "failed";
    }
  }

  async stop(force = false): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const child = this.child;
    if (!child) {
      this.stateValue = "closed";
      return;
    }
    this.stopping = true;
    this.stateValue = "closing";
    this.closePromise = new Promise<void>((resolve) => {
      let forced: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (forced) clearTimeout(forced);
        this.stateValue = "closed";
        this.events.close();
        resolve();
      };
      if (child.exitCode !== null || child.signalCode !== null) {
        finish();
        return;
      }
      child.once("close", finish);
      try {
        child.stdin?.end();
      } catch {
        // Continue to termination below.
      }
      forced = setTimeout(() => {
        terminateAgyProcess(child, true);
      }, force ? 250 : 3_000);
      forced.unref?.();
      if (force) terminateAgyProcess(child);
    });
    await this.closePromise;
    debug("agy worker stopped", { state: this.stateValue, force });
  }

  async restart(options: AgyWorkerOptions, executable = this.executable): Promise<AgyWorker> {
    await this.stop();
    const worker = new AgyWorker(options, executable);
    await worker.start();
    return worker;
  }
}

export async function createAgyWorker(options: AgyWorkerOptions, signal?: AbortSignal): Promise<AgyWorker> {
  const executable = options.executable ?? (await detectAgy()).executable ?? await resolveAgyExecutable();
  const worker = new AgyWorker({
    ...options,
    printTimeoutMs: options.printTimeoutMs ?? configuredPrintTimeoutMs(),
  }, executable);
  await worker.start(signal);
  return worker;
}
