import { describe, expect, test } from "bun:test";
import { mapAgyEvent, usageFromAgy, appendResultWithoutDuplication, collectTurn } from "../src/translate.js";

describe("agy to OpenAI translation", () => {
  test("maps token usage without inventing price", () => {
    expect(usageFromAgy({ input_tokens: 10, output_tokens: 4, thinking_tokens: 3, cache_read_tokens: 2, total_tokens: 14 })).toEqual({
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      prompt_tokens_details: { cached_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 3 },
    });
  });

  test("surfaces tool activity as reasoning metadata", () => {
    const mapped = mapAgyEvent({ event: "step_update", step_update: { step_type: "tool", tool_name: "run_command", state: "DONE" }, raw: {} });
    expect(mapped).toEqual({ kind: "reasoning", text: "[agy tool: run_command (done)]\n" });
  });

  test("does not duplicate the terminal result after deltas", async () => {
    expect(appendResultWithoutDuplication("hello", "hello world")).toBe(" world");
    expect(appendResultWithoutDuplication("hello", "different")).toBeUndefined();
    const result = await collectTurn((async function* () {
      yield { event: "step_update", step_update: { text_delta: "hello" }, raw: {} } as const;
      yield { event: "result", result: { status: "SUCCESS", response: "hello\n" }, raw: {} } as const;
    })());
    expect(result.content).toBe("hello\n");
  });
});
