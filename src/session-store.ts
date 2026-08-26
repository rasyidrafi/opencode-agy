import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_IDLE_WORKER_TIMEOUT_MS } from "./constants.js";
import { debug, warn } from "./log.js";

export type SessionRecord = {
  sessionId: string;
  model: string;
  effort?: string;
  cwd: string;
  cliVersion: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
};

type DiskStore = Record<string, SessionRecord>;

function dataDirectory(): string {
  return process.env.OPENCODE_AGY_DATA_DIR?.trim() ||
    join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "opencode-agy");
}

function storePath(): string {
  return join(dataDirectory(), "sessions.json");
}

function validRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.sessionId === "string" &&
    typeof record.model === "string" &&
    typeof record.cwd === "string" &&
    (typeof record.cliVersion === "string" || record.cliVersion === null);
}

function sanitizeRecord(value: SessionRecord): SessionRecord {
  return {
    sessionId: value.sessionId.slice(0, 200),
    model: value.model.slice(0, 200),
    ...(value.effort ? { effort: value.effort.slice(0, 20) } : {}),
    cwd: value.cwd.slice(0, 4_000),
    cliVersion: value.cliVersion?.slice(0, 80) ?? null,
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
    lastUsedAt: Number.isFinite(value.lastUsedAt) ? value.lastUsedAt : Date.now(),
  };
}

export class SessionStore {
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private records: DiskStore = {};
  private writePromise: Promise<void> = Promise.resolve();

  private async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      try {
        const raw = await readFile(storePath(), "utf8");
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
           for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
             if (validRecord(value)) this.records[key] = sanitizeRecord(value);
          }
        }
        try {
          await chmod(dataDirectory(), 0o700);
          await chmod(storePath(), 0o600);
        } catch {
          // Best effort on filesystems without POSIX modes.
        }
      } catch (error) {
        const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
        if (code !== "ENOENT") warn("session metadata could not be loaded; starting with an empty store", { code });
      } finally {
        this.loaded = true;
        this.loadPromise = null;
      }
    })();
    return this.loadPromise;
  }

  async get(key: string): Promise<SessionRecord | undefined> {
    await this.load();
    const record = this.records[key];
    return record ? { ...record } : undefined;
  }

  async set(key: string, record: SessionRecord): Promise<void> {
    await this.load();
    this.records[key] = sanitizeRecord(record);
    await this.persist();
  }

  async delete(key: string): Promise<void> {
    await this.load();
    if (!(key in this.records)) return;
    delete this.records[key];
    await this.persist();
  }

  async entries(): Promise<Array<[string, SessionRecord]>> {
    await this.load();
    return Object.entries(this.records).map(([key, value]) => [key, { ...value }]);
  }

  async prune(maxIdleMs = DEFAULT_IDLE_WORKER_TIMEOUT_MS * 4, protectedKeys: ReadonlySet<string> = new Set()): Promise<void> {
    await this.load();
    const threshold = Date.now() - maxIdleMs;
    let changed = false;
    for (const [key, record] of Object.entries(this.records)) {
      if (protectedKeys.has(key)) continue;
      if (record.lastUsedAt < threshold) {
        delete this.records[key];
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.records, null, 2);
    this.writePromise = this.writePromise.catch(() => undefined).then(async () => {
      await mkdir(dataDirectory(), { recursive: true, mode: 0o700 });
      try {
        await chmod(dataDirectory(), 0o700);
      } catch {
        // Best effort on filesystems without POSIX modes.
      }
      const temporary = join(dataDirectory(), `.sessions.${process.pid}.${randomUUID()}.tmp`);
      await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
      try {
        await chmod(temporary, 0o600);
      } catch {
        // Best effort on Windows.
      }
      await rename(temporary, storePath());
      try {
        await chmod(storePath(), 0o600);
      } catch {
        // Best effort on Windows.
      }
      debug("persisted non-secret session metadata", { records: Object.keys(this.records).length });
    }).catch(async (error) => {
      warn("could not persist non-secret session metadata", { code: error && typeof error === "object" ? (error as { code?: unknown }).code : undefined });
      throw error;
    });
    return this.writePromise;
  }

  async clear(): Promise<void> {
    this.records = {};
    this.loaded = true;
    await this.writePromise;
    try {
      await unlink(storePath());
    } catch (error) {
      const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
      if (code !== "ENOENT") throw error;
    }
  }
}

export const sessionStore = new SessionStore();

export function sessionStoreDirectory(): string {
  return dataDirectory();
}
