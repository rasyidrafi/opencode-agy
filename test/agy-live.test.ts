import { describe, expect, test } from "bun:test";
import { createAgyWorker } from "../src/cli-process.js";
import { captureAgyCommand, detectAgy } from "../src/cli-detect.js";
import { discoverAgyModels } from "../src/models.js";
import { resolveAgyModelSelection } from "../src/models.js";
import { parseNdjsonLine } from "../src/protocol.js";

const live = process.env.OPENCODE_AGY_LIVE === "1";

describe("opt-in official agy live checks", () => {
  test.skipIf(!live)("discovers the authenticated CLI and answers a text turn", async () => {
    const detection = await detectAgy(true);
    expect(detection.version).toBeTruthy();
    const catalog = await discoverAgyModels(true, process.cwd());
    expect(catalog.exactModels.length).toBeGreaterThan(0);
    const requested = catalog.models.find((model) => model.variants && Object.keys(model.variants).length > 0)?.id ?? catalog.exactModels[0].id;
    const selection = resolveAgyModelSelection(requested, "low", catalog);
    const worker = await createAgyWorker({ cwd: process.cwd(), executable: detection.executable, model: selection.cliModel, effort: selection.effort, stallTimeoutMs: 120_000 });
    const responses: string[] = [];
    try {
      for (const prompt of [
        "Remember the code AGY_LIVE_CONTEXT_42. Reply with exactly SAVED.",
        "What code did I ask you to remember? Reply with only the code.",
      ]) {
        for await (const event of worker.runTurn(prompt)) {
          if (event.event === "result") responses.push(event.result.response ?? "");
        }
      }
      const conversationId = worker.conversationId;
      expect(conversationId).toBeTruthy();
      await worker.stop(true);
      const resumed = await createAgyWorker({ cwd: process.cwd(), executable: detection.executable, model: selection.cliModel, effort: selection.effort, conversationId, stallTimeoutMs: 120_000 });
      try {
        for await (const event of resumed.runTurn("Reply with the remembered code only.")) {
          if (event.event === "result") responses.push(event.result.response ?? "");
        }
      } finally {
        await resumed.stop(true);
      }
    } finally {
      await worker.stop(true);
    }
    expect(responses[0]).toContain("SAVED");
    expect(responses[1]).toContain("AGY_LIVE_CONTEXT_42");
    expect(responses[2]).toContain("AGY_LIVE_CONTEXT_42");
  }, 300_000);

  test.skipIf(!live)("reads documented one-shot JSON and stream-JSON output", async () => {
    const detection = await detectAgy();
    const catalog = await discoverAgyModels(false, process.cwd());
    const model = catalog.exactModels[0].id;
    const json = await captureAgyCommand(["-p", "Reply with exactly AGY_LIVE_JSON_OK and nothing else.", "--model", model, "--output-format", "json", "--print-timeout", "120s"], {
      executable: detection.executable,
      cwd: process.cwd(),
      timeoutMs: 180_000,
    });
    const envelope = JSON.parse(json.stdout.trim());
    expect(envelope.status).toBe("SUCCESS");
    expect(envelope.response).toContain("AGY_LIVE_JSON_OK");

    const stream = await captureAgyCommand(["-p", "Reply with exactly AGY_LIVE_STREAM_OK and nothing else.", "--model", model, "--output-format", "stream-json", "--print-timeout", "120s"], {
      executable: detection.executable,
      cwd: process.cwd(),
      timeoutMs: 180_000,
    });
    const events = stream.stdout.split(/\r?\n/).filter(Boolean).map((line) => parseNdjsonLine(line));
    expect(events[0].event).toBe("init");
    expect(events.some((event) => event.event === "result" && event.result.status === "SUCCESS" && event.result.response?.includes("AGY_LIVE_STREAM_OK"))).toBe(true);
  }, 600_000);

  test.skipIf(!live)("runs a safe headless sandbox/file-read request", async () => {
    const detection = await detectAgy();
    const catalog = await discoverAgyModels(false, process.cwd());
    const result = await captureAgyCommand([
      "-p",
      "Read the first line of PLAN.md using your file-reading tool. Do not modify any files. Reply with exactly FILE_READ_OK if the read succeeds.",
      "--model",
      catalog.exactModels[0].id,
      "--sandbox",
      "--dangerously-skip-permissions",
      "--output-format",
      "json",
      "--print-timeout",
      "120s",
    ], { executable: detection.executable, cwd: process.cwd(), timeoutMs: 180_000 });
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.status).toBe("SUCCESS");
    expect(envelope.response).toContain("FILE_READ_OK");
  }, 300_000);

  test.skipIf(!live)("cancels an official persistent worker request", async () => {
    const detection = await detectAgy();
    const catalog = await discoverAgyModels(false, process.cwd());
    const worker = await createAgyWorker({ cwd: process.cwd(), executable: detection.executable, model: catalog.exactModels[0].id, stallTimeoutMs: 120_000 });
    const controller = new AbortController();
    const turn = (async () => {
      for await (const _event of worker.runTurn("Explain why a long-running task should be cancellable.", controller.signal)) {
        // Cancellation is asserted below.
      }
    })();
    setTimeout(() => controller.abort(), 50).unref?.();
    await expect(turn).rejects.toThrow(/cancel/i);
    expect(worker.state).toBe("closed");
  }, 300_000);
});
