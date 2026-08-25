import { mkdtemp, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const fixture = join(import.meta.dir, "fixtures", "fake-agy.mjs");
process.env.OPENCODE_AGY_PATH = fixture;
process.env.OPENCODE_AGY_DATA_DIR = await mkdtemp(join(tmpdir(), "opencode-agy-test-"));

const { getProxyBaseUrl, startProxy, stopProxy } = await import("../src/proxy.js");

describe("loopback proxy smoke test", () => {
  beforeAll(async () => {
    await chmod(fixture, 0o755);
    await startProxy(process.cwd());
  });

  afterAll(async () => {
    await stopProxy();
  });

  test("serves health, models, non-streaming, and streaming responses", async () => {
    const base = getProxyBaseUrl();
    expect((await fetch(base.replace(/\/v1$/, "") + "/health")).status).toBe(200);
    const models = await (await fetch(base + "/models", { headers: { authorization: "Bearer opencode-agy-local" } })).json();
    expect(models.data.some((model: { id: string }) => model.id === "fake-model")).toBe(true);
    const headers = { "content-type": "application/json", authorization: "Bearer opencode-agy-local", "x-opencode-agy-session": "smoke" };
    const first = await fetch(base + "/chat/completions", { method: "POST", headers, body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "remember FAKE_MEMORY" }] }) });
    expect(first.status).toBe(200);
    expect((await first.json()).choices[0].message.content).toContain("FAKE_OK");
    const second = await fetch(base + "/chat/completions", { method: "POST", headers, body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "what did you remember" }], stream: true }) });
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("FAKE_MEMORY");
  });

  test("requires the non-secret local proxy marker for model requests", async () => {
    const base = getProxyBaseUrl();
    const response = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "x" }] }),
    });
    expect(response.status).toBe(401);
  });

  test("ignores host tool definitions but rejects media explicitly", async () => {
    const base = getProxyBaseUrl();
    const headers = { "content-type": "application/json", authorization: "Bearer opencode-agy-local" };
    const tools = await fetch(base + "/chat/completions", { method: "POST", headers, body: JSON.stringify({ model: "fake-model", tools: [{ type: "function" }], messages: [{ role: "user", content: "x" }] }) });
    expect(tools.status).toBe(200);
    const required = await fetch(base + "/chat/completions", { method: "POST", headers, body: JSON.stringify({ model: "fake-model", tool_choice: "required", tools: [{ type: "function" }], messages: [{ role: "user", content: "x" }] }) });
    expect(required.status).toBe(400);
    const media = await fetch(base + "/chat/completions", { method: "POST", headers, body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] }) });
    expect(media.status).toBe(400);
  });

  test("does not terminate a partial failed stream as a successful stream", async () => {
    const base = getProxyBaseUrl();
    const response = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer opencode-agy-local" },
      body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "FAKE_PARTIAL_AUTH" }], stream: true }),
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("authentication_error");
    expect(text).not.toContain("[DONE]");
  });
});
