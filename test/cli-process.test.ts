import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createAgyWorker } from "../src/cli-process.js";

const fixture = join(import.meta.dir, "fixtures", "fake-agy.mjs");

describe("agy process manager", () => {
  test("runs two serialized turns through one persistent worker", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAgyWorker({ cwd: process.cwd(), executable: fixture, model: "fake-model-low", stallTimeoutMs: 10_000 });
    const responses: string[] = [];
    try {
      for await (const event of worker.runTurn("remember FAKE_MEMORY")) {
        if (event.event === "step_update" && event.step_update.text_delta) responses.push(event.step_update.text_delta);
      }
      for await (const event of worker.runTurn("what did you remember")) {
        if (event.event === "step_update" && event.step_update.text_delta) responses.push(event.step_update.text_delta);
      }
    } finally {
      await worker.stop(true);
    }
    expect(responses.join("")).toContain("FAKE_MEMORY");
    expect(worker.state).toBe("closed");
  });

  test("cancels a stalled turn and closes the process", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAgyWorker({ cwd: process.cwd(), executable: fixture, model: "fake-model-low", stallTimeoutMs: 30_000 });
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

  test("reports a CLI exit before a result as a process failure", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAgyWorker({ cwd: process.cwd(), executable: fixture, model: "fake-model-low", stallTimeoutMs: 10_000 });
    const turn = (async () => {
      for await (const _event of worker.runTurn("FAKE_EXIT")) {
        // The fixture exits before emitting a result.
      }
    })();
    await expect(turn).rejects.toThrow(/agy process|ended/i);
    expect(worker.state).toBe("closed");
  });
});
