import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");
process.env.OPENCODE_AGY_ACP_PATH = fixture;
process.env.OPENCODE_AGY_DATA_DIR = await mkdtemp(join(tmpdir(), "opencode-agy-test-"));
const secondWorkspace = await mkdtemp(join(tmpdir(), "opencode-agy-workspace-"));
const outsideWorkspace = await mkdtemp(join(tmpdir(), "opencode-agy-outside-"));
const { getProxyBaseUrl, startProxy, stopProxy } = await import("../src/proxy.js");

const authHeaders = { "content-type": "application/json", "x-api-key": "opencode-agy-local" };
const message = (content: unknown, extra: Record<string, unknown> = {}) => ({ model: "gemini-3.7-flash", max_tokens: 4096, messages: [{ role: "user", content }], ...extra });

describe("loopback Anthropic proxy", () => {
  beforeAll(async () => { await chmod(fixture, 0o755); await startProxy(process.cwd()); });
  afterAll(async () => {
    await stopProxy();
    await Promise.all([rm(secondWorkspace, { recursive: true, force: true }), rm(outsideWorkspace, { recursive: true, force: true })]);
  });

  test("serves Anthropic messages and ordered streaming", async () => {
    const base = getProxyBaseUrl();
    expect((await fetch(base.replace(/\/v1$/, "") + "/health")).status).toBe(200);
    const models = await (await fetch(base + "/models", { headers: { "x-api-key": "opencode-agy-local" } })).json();
    expect(models.data.some((model: { id: string }) => model.id === "gemini-3.7-flash")).toBe(true);
    const sessionHeaders = { ...authHeaders, "x-opencode-agy-session": "smoke" };
    const first = await fetch(base + "/messages", { method: "POST", headers: sessionHeaders, body: JSON.stringify(message("remember FAKE_MEMORY")) });
    expect(first.status).toBe(200);
    expect((await first.json()).content[0].text).toContain("FAKE_OK");
    const second = await fetch(base + "/messages", { method: "POST", headers: sessionHeaders, body: JSON.stringify(message("what did you remember", { stream: true })) });
    const text = await second.text();
    expect(second.status).toBe(200);
    expect(text).toContain("FAKE_MEMORY");
    expect(text).toContain("message_start");
    expect(text).toContain("message_stop");
  });

  test("keeps thinking, plans, tools, and text in separate ordered blocks", async () => {
    const response = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers: authHeaders, body: JSON.stringify(message("FAKE_PROGRESS", { stream: true })) });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text.indexOf("thinking about the request")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Inspect the workspace")).toBeGreaterThan(text.indexOf("thinking about the request"));
    expect(text.indexOf("Read files")).toBeGreaterThan(text.indexOf("Inspect the workspace"));
    expect(text.indexOf("progressive answer")).toBeGreaterThan(text.indexOf("Read files"));
    expect(text).toContain('"type":"content_block_start"');
    expect(text).toContain('"type":"message_stop"');
  });

  test("requires the local marker", async () => {
    const response = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message("x")) });
    expect(response.status).toBe(401);
  });

  test("allows registered workspaces and rejects unknown ones", async () => {
    await startProxy(secondWorkspace);
    const accepted = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers: { ...authHeaders, "x-opencode-agy-directory": secondWorkspace }, body: JSON.stringify(message("x")) });
    expect(accepted.status).toBe(200);
    const rejected = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers: { ...authHeaders, "x-opencode-agy-directory": outsideWorkspace }, body: JSON.stringify(message("x")) });
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error.message).toContain("outside");
  });

  test("accepts Anthropic image blocks and ignores host tools", async () => {
    const response = await fetch(getProxyBaseUrl() + "/messages", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(message([{ type: "text", text: "x" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }], { tools: [{ name: "host_tool", input_schema: { type: "object" } }], tool_choice: { type: "auto" } })),
    });
    expect(response.status).toBe(200);
  });

  test("does not terminate a failed stream as success", async () => {
    const response = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers: authHeaders, body: JSON.stringify(message("FAKE_AUTH_ERROR", { stream: true })) });
    const text = await response.text();
    expect(response.status).toBe(401);
    expect(text).toContain('"type":"error"');
    expect(text).not.toContain('"type":"message_stop"');
  });
});
