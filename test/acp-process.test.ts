import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createAcpWorker } from "../src/acp-process.js";

const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");

describe("ACP process manager", () => {
  test("runs two serialized turns through one persistent worker", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "fake-model-low", stallTimeoutMs: 10_000 });
    const responses: string[] = [];
    try {
      for await (const event of worker.runTurn("remember FAKE_MEMORY")) {
        if (event.event === "update" && (event.update as { sessionUpdate?: string }).sessionUpdate === "agent_message_chunk") {
          const content = (event.update as { content?: { text?: string } }).content;
          if (content?.text) responses.push(content.text);
        }
      }
      for await (const event of worker.runTurn("what did you remember")) {
        if (event.event === "update" && (event.update as { sessionUpdate?: string }).sessionUpdate === "agent_message_chunk") {
          const content = (event.update as { content?: { text?: string } }).content;
          if (content?.text) responses.push(content.text);
        }
      }
    } finally {
      await worker.stop(true);
    }
    expect(responses.join("")).toContain("FAKE_MEMORY");
    expect(worker.state).toBe("closed");
  });

  test("cancels a stalled turn and closes the process", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "fake-model-low", stallTimeoutMs: 30_000 });
    const controller = new AbortController();
    const turn = (async () => {
      for await (const _event of worker.runTurn("FAKE_HANG", controller.signal)) {
        // The fixture intentionally emits no result.
      }
    })();
    setTimeout(() => controller.abort(), 25).unref?.();
    await expect(turn).rejects.toThrow(/cancel/i);
    expect(worker.state).toBe("closed");
  });

  test("answers ACP permission requests with the configured autonomous policy", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "fake-model-low", permissionPolicy: "allow-always" });
    let sawTool = false;
    try {
      for await (const event of worker.runTurn("FAKE_PERMISSION")) {
        if (event.event === "update" && (event.update as { sessionUpdate?: string }).sessionUpdate === "tool_call") sawTool = true;
      }
    } finally {
      await worker.stop(true);
    }
    expect(sawTool).toBe(true);
  });

  test("can authenticate an ACP server without creating a workspace session", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAcpWorker({ cwd: process.cwd(), executable: fixture, authMethod: "oauth-personal", skipSession: true });
    expect(worker.init?.authMethods?.[0]?.id).toBe("oauth-personal");
    await worker.stop(true);
  });

  test("reports an ACP server exit before a result as a process failure", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "fake-model-low", stallTimeoutMs: 10_000 });
    const turn = (async () => {
      for await (const _event of worker.runTurn("FAKE_EXIT")) {
        // The fixture exits before emitting a result.
      }
    })();
    await expect(turn).rejects.toThrow(/ACP|ended/i);
    expect(worker.state).toBe("closed");
  });
});
