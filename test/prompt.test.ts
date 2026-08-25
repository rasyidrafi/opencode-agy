import { describe, expect, test } from "bun:test";
import { UnsupportedMediaError } from "../src/errors.js";
import { buildBoundedHistory, normalizePrompt, stableConversationKey } from "../src/prompt.js";

describe("prompt normalization", () => {
  test("extracts only the latest user text and bounded prior context", () => {
    const prompt = normalizePrompt([
      { role: "system", content: "Be concise" },
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ]);
    expect(prompt.text).toBe("second");
    expect(buildBoundedHistory(prompt.priorMessages, 500)).toContain("first");
    expect(stableConversationKey([{ role: "user", content: "first" }])).toHaveLength(48);
  });

  test("rejects media instead of silently dropping it", () => {
    expect(() => normalizePrompt([{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }])).toThrow(UnsupportedMediaError);
  });

  test("rejects host tool calls", () => {
    expect(() => normalizePrompt([{ role: "assistant", content: "x", tool_calls: [] }, { role: "user", content: "next" }])).toThrow(/tool calls/i);
  });
});
