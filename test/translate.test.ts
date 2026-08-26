import { describe, expect, test } from "bun:test";
import { mapAcpEvent, usageFromAcp, appendResultWithoutDuplication, collectTurn, createAcpTranslationState } from "../src/translate.js";

describe("ACP to Anthropic translation", () => {
  test("maps token usage without inventing price", () => {
    expect(usageFromAcp({ inputTokens: 10, outputTokens: 4, thoughtTokens: 3, cacheReadTokens: 2, totalTokens: 14 })).toEqual({
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 2,
      output_tokens_details: { thinking_tokens: 3 },
    });
  });

  test("shows a tool once as running and omits successful completion", () => {
    const state = createAcpTranslationState();
    const started = mapAcpEvent({ event: "update", sessionId: "s", update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "run_command", kind: "execute", status: "in_progress" } }, state);
    expect(started).toEqual({ kind: "activity", text: "[Antigravity ACP tool: Running run_command]" });
    const repeated = mapAcpEvent({ event: "update", sessionId: "s", update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", title: "run_command", kind: "execute", status: "in_progress" } }, state);
    expect(repeated).toEqual({ kind: "ignore" });
    const completed = mapAcpEvent({ event: "update", sessionId: "s", update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" } }, state);
    expect(completed).toEqual({ kind: "ignore" });
  });

  test("streams plan and tool output details as ordered activity", () => {
    const plan = mapAcpEvent({
      event: "update",
      sessionId: "s",
      update: {
        sessionUpdate: "plan",
        entries: [{ content: "Inspect the repository", priority: "high", status: "in_progress" }],
      } as any,
    });
    expect(plan).toEqual({ kind: "activity", text: "[Antigravity ACP plan]\n- [in_progress] Inspect the repository" });

    const tool = mapAcpEvent({
      event: "update",
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        title: "read files",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "package.json" } }],
      } as any,
    });
    expect(tool.kind).toBe("activity");
    expect((tool as any).text).toContain("read files");
    expect((tool as any).text).toContain("package.json");
  });

  test("does not duplicate the terminal result after deltas", async () => {
    expect(appendResultWithoutDuplication("hello", "hello world")).toBe(" world");
    expect(appendResultWithoutDuplication("hello", "different")).toBeUndefined();
    const result = await collectTurn((async function* () {
      yield { event: "update", sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } } as const;
      yield { event: "result", sessionId: "s", result: { stopReason: "end_turn" } } as const;
    })());
    expect(result.content).toBe("hello");
  });
});
