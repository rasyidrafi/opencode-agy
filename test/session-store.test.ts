import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { SessionStore } from "../src/session-store.js";

describe("non-secret session persistence", () => {
  test("writes restrictive metadata and no credential fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-agy-store-"));
    process.env.OPENCODE_AGY_DATA_DIR = directory;
    const store = new SessionStore();
    await store.set("hashed-session", {
      conversationId: "conversation-id",
      model: "model",
      effort: "low",
      cwd: "/workspace",
      cliVersion: "1.1.20",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    const raw = JSON.parse(await readFile(join(directory, "sessions.json"), "utf8"));
    expect(raw["hashed-session"].conversationId).toBe("conversation-id");
    expect(JSON.stringify(raw)).not.toContain("refresh");
    expect(JSON.stringify(raw)).not.toContain("access");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "sessions.json"))).mode & 0o777).toBe(0o600);
  });
});
