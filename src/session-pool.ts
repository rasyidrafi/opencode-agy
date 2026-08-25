import { AgyWorker, createAgyWorker, type AgyWorkerOptions } from "./cli-process.js";
import { detectAgy } from "./cli-detect.js";
import {
  AgyAbortError,
  AgyBusyError,
  AgyError,
  AgyProcessError,
  classifyAgyText,
  failureFromCliResult,
} from "./errors.js";
import {
  DEFAULT_IDLE_WORKER_TIMEOUT_MS,
  DEFAULT_MAX_QUEUE_PER_SESSION,
  DEFAULT_MAX_SESSIONS,
  envBoolean,
  envNumber,
  type AgyEffort,
} from "./constants.js";
import { buildBoundedHistory, withOptionalHistory } from "./prompt.js";
import { resultConversationId, type AgyEvent } from "./protocol.js";
import { sessionStore, type SessionRecord } from "./session-store.js";
import { debug, info, warn } from "./log.js";

export type SessionSettings = {
  cwd: string;
  model: string;
  effort?: AgyEffort;
  agent?: string;
  mode?: "accept-edits" | "plan";
  sandbox?: boolean;
  cliVersion?: string | null;
  executable?: string;
};

export type SessionTurnRequest = {
  key: string;
  prompt: string;
  priorMessages?: Array<{ role?: unknown; content?: unknown }>;
  settings: SessionSettings;
  signal?: AbortSignal;
};

type SessionEntry = {
  worker?: AgyWorker;
  settingsSignature?: string;
  tail: Promise<void>;
  pending: number;
  lastUsedAt: number;
  record?: SessionRecord;
  turnCount: number;
};

function settingsSignature(settings: SessionSettings): string {
  return JSON.stringify({
    cwd: settings.cwd,
    model: settings.model,
    effort: settings.effort ?? null,
    agent: settings.agent ?? null,
    mode: settings.mode ?? null,
    sandbox: Boolean(settings.sandbox),
  });
}

function waitForPrevious(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  if (signal.aborted) return Promise.reject(new AgyAbortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new AgyAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    previous.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function combineSignals(left: AbortSignal | undefined, right: AbortSignal): AbortSignal {
  if (!left) return right;
  if (left.aborted || right.aborted) {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  left.addEventListener("abort", abort, { once: true });
  right.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

function isLostConversation(message: string): boolean {
  return /no conversation found|conversation .*not found|session .*not found|could not (?:find|load|resume).*(?:session|conversation)|could not be resumed|invalid conversation/i.test(message);
}

function workerOptions(settings: SessionSettings, conversationId?: string): AgyWorkerOptions {
  return {
    cwd: settings.cwd,
    executable: settings.executable,
    model: settings.model,
    effort: settings.effort,
    agent: settings.agent,
    conversationId,
    mode: settings.mode,
    sandbox: settings.sandbox,
  };
}

export class SessionPool {
  private entries = new Map<string, SessionEntry>();
  private readonly maxQueue: number;
  private readonly maxSessions: number;
  private readonly idleMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private lifecycleController = new AbortController();

  constructor(options: { maxQueue?: number; idleMs?: number } = {}) {
    this.maxQueue = Math.max(0, Math.floor(options.maxQueue ?? envNumber("OPENCODE_AGY_MAX_QUEUE", DEFAULT_MAX_QUEUE_PER_SESSION, 0)));
    this.maxSessions = Math.max(1, Math.floor(envNumber("OPENCODE_AGY_MAX_SESSIONS", DEFAULT_MAX_SESSIONS, 1)));
    this.idleMs = options.idleMs ?? envNumber("OPENCODE_AGY_IDLE_WORKER_MS", DEFAULT_IDLE_WORKER_TIMEOUT_MS, 1_000);
    this.open();
  }

  open(): void {
    if (!this.disposed && this.cleanupTimer) return;
    this.disposed = false;
    this.lifecycleController = new AbortController();
    this.cleanupTimer = setInterval(() => void this.cleanup(), Math.min(this.idleMs, 60_000));
    this.cleanupTimer.unref?.();
  }

  get size(): number {
    return this.entries.size;
  }

  async *turn(request: SessionTurnRequest): AsyncGenerator<AgyEvent> {
    if (this.disposed) throw new AgyProcessError("The Antigravity session pool has been shut down");
    let entry = this.entries.get(request.key);
    if (!entry) {
      if (this.entries.size >= this.maxSessions) throw new AgyBusyError("The Antigravity session pool has reached its session limit");
      entry = { tail: Promise.resolve(), pending: 0, lastUsedAt: Date.now(), turnCount: 0 };
      this.entries.set(request.key, entry);
    }
    if (entry.pending > this.maxQueue) throw new AgyBusyError();
    entry.pending += 1;
    entry.lastUsedAt = Date.now();
    const signal = combineSignals(request.signal, this.lifecycleController.signal);
    let release!: () => void;
    const previous = entry.tail.catch(() => undefined);
    entry.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await waitForPrevious(previous, signal);
      if (this.disposed) throw new AgyProcessError("The Antigravity session pool has been shut down");
      if (signal.aborted) throw new AgyAbortError();
      yield* this.runTurn(entry, { ...request, signal });
    } finally {
      release();
      entry.pending = Math.max(0, entry.pending - 1);
      entry.lastUsedAt = Date.now();
    }
  }

  private async *runTurn(entry: SessionEntry, request: SessionTurnRequest): AsyncGenerator<AgyEvent> {
    const signature = settingsSignature(request.settings);
    let record = entry.record ?? await sessionStore.get(request.key);
    entry.record = record;
    let hadStoredConversation = Boolean(record?.conversationId);

    if (entry.worker && (entry.worker.state === "closed" || entry.worker.state === "failed")) {
      entry.worker = undefined;
      entry.settingsSignature = undefined;
    }
    if (entry.worker && entry.settingsSignature !== signature) {
      await this.persistWorkerSafe(entry, request.key, request.settings);
      await entry.worker.stop();
      entry.worker = undefined;
      entry.settingsSignature = undefined;
    }
    if (!entry.worker) {
      const conversationId = record?.conversationId;
      try {
        entry.worker = await createAgyWorker(workerOptions(request.settings, conversationId), request.signal);
      } catch (error) {
        // A resume failure occurs before this worker has accepted the prompt,
        // so retrying once without --conversation is safe. Process failures
        // after stdin was written are never retried automatically.
        if (!conversationId || !isLostConversation(error instanceof Error ? error.message : String(error))) throw error;
        warn("saved agy conversation could not be resumed; clearing its metadata", { poolSize: this.entries.size });
        await sessionStore.delete(request.key);
        entry.record = undefined;
        record = undefined;
        hadStoredConversation = false;
        entry.worker = await createAgyWorker(workerOptions(request.settings), request.signal);
      }
      entry.settingsSignature = signature;
      const workerConversation = entry.worker.conversationId;
      if (workerConversation) await this.persistWorkerSafe(entry, request.key, request.settings);
      info("created agy session worker", { resumed: Boolean(conversationId), poolSize: this.entries.size });
    }

    const history = !hadStoredConversation && request.priorMessages?.length
      ? buildBoundedHistory(request.priorMessages)
      : "";
    const prompt = withOptionalHistory(request.prompt, history);

    let lostResume = false;
    let sawResult = false;
    let sawContent = false;
    try {
      for await (const event of entry.worker.runTurn(prompt, request.signal)) {
        if (event.event === "step_update" && (
          Boolean(event.step_update.text_delta) ||
          Boolean(event.step_update.text) ||
          Boolean(event.step_update.tool_info) ||
          Boolean(event.step_update.subagent_info)
        )) sawContent = true;
        if (event.event === "result") {
          sawResult = true;
          const failure = failureFromCliResult(event.result);
          if (failure && hadStoredConversation && !sawContent && isLostConversation(failure.message)) {
            lostResume = true;
            break;
          }
        }
        yield event;
      }
    } catch (error) {
      // Do not retry a process failure: the prompt may have been accepted by
      // the remote agent. The next user turn can resume the saved id.
      if (error instanceof AgyError) throw error;
      throw new AgyProcessError("The agy turn failed", error);
    }

    if (lostResume && !sawResult) {
      // Defensive; a lost-resume result always sets sawResult above.
      throw new AgyProcessError("The saved Antigravity conversation could not be resumed");
    }
    if (lostResume) {
      warn("stored agy conversation was unavailable; transferring bounded host history", { poolSize: this.entries.size });
      await entry.worker.stop(true);
      entry.worker = await createAgyWorker(workerOptions(request.settings));
      entry.settingsSignature = signature;
      hadStoredConversation = false;
      entry.record = undefined;
      const retryHistory = request.priorMessages?.length ? buildBoundedHistory(request.priorMessages) : "";
      const retryPrompt = withOptionalHistory(request.prompt, retryHistory);
      for await (const event of entry.worker.runTurn(retryPrompt, request.signal)) yield event;
    }
    entry.turnCount += 1;
    await this.persistWorkerSafe(entry, request.key, request.settings);
  }

  private async persistWorkerSafe(entry: SessionEntry, key: string, settings: SessionSettings): Promise<void> {
    try {
      await this.persistWorker(entry, key, settings);
    } catch (error) {
      // A metadata filesystem failure must not turn a completed remote turn
      // into a fake assistant failure. Resume may be unavailable next time;
      // the current response remains authoritative.
      warn("could not persist agy session metadata", { code: error && typeof error === "object" ? (error as { code?: unknown }).code : undefined });
    }
  }

  private async persistWorker(entry: SessionEntry, key: string, settings: SessionSettings): Promise<void> {
    const worker = entry.worker;
    const conversationId = worker?.conversationId ?? entry.record?.conversationId;
    if (!conversationId) return;
    const now = Date.now();
    const previous = entry.record;
    const record: SessionRecord = {
      conversationId,
      model: settings.model,
      ...(settings.effort ? { effort: settings.effort } : {}),
      cwd: settings.cwd,
      cliVersion: settings.cliVersion ?? previous?.cliVersion ?? null,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: now,
    };
    entry.record = record;
    await sessionStore.set(key, record);
  }

  async cleanup(): Promise<void> {
    if (this.disposed) return;
    const threshold = Date.now() - this.idleMs;
    for (const [key, entry] of this.entries) {
      if (entry.pending === 0 && entry.lastUsedAt < threshold) {
        this.entries.delete(key);
        await entry.worker?.stop();
        debug("cleaned up idle agy worker", { poolSize: this.entries.size });
      }
    }
    try {
      await sessionStore.prune(undefined, new Set([...this.entries].filter(([, entry]) => entry.pending > 0).map(([key]) => key)));
    } catch (error) {
      warn("could not prune agy session metadata", { code: error && typeof error === "object" ? (error as { code?: unknown }).code : undefined });
    }
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycleController.abort();
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    const workers = [...this.entries.values()].map((entry) => entry.worker?.stop());
    await Promise.all(workers);
    this.entries.clear();
  }

  async forget(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry?.pending) throw new AgyBusyError("Cannot forget an active Antigravity session");
    await entry?.worker?.stop();
    this.entries.delete(key);
    await sessionStore.delete(key);
  }

  async status(key: string): Promise<Record<string, unknown>> {
    const entry = this.entries.get(key);
    const record = entry?.record ?? await sessionStore.get(key);
    return {
      active: Boolean(entry?.pending),
      workerState: entry?.worker?.state ?? "none",
      hasConversation: Boolean(record?.conversationId || entry?.worker?.conversationId),
      turns: entry?.turnCount ?? 0,
    };
  }
}

export const sessionPool = new SessionPool();
