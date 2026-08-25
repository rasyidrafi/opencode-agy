import { describe, expect, test } from "bun:test";
import { parseAgyUsageEnvelope, parseAgyUsageText } from "../src/agy-usage.js";

describe("official agy /usage parsing", () => {
  test("parses documented command data into five-hour and weekly windows", () => {
    const snapshot = parseAgyUsageEnvelope({
      status: "SUCCESS",
      command: {
        data: {
          groups: [{
            name: "Gemini Models",
            buckets: [
              { window: "weekly", remaining_fraction: 0.97, reset_time: "2026-08-28T01:53:59Z" },
              { window: "5h", remaining_fraction: 0.95, reset_time: "2026-08-25T13:06:20Z" },
            ],
          }],
        },
      },
    });
    expect(snapshot.ok).toBe(true);
    expect(snapshot.usage?.windows.weekly.remainingPercent).toBe(97);
    expect(snapshot.usage?.windows["5h"].usedPercent).toBe(5);
    expect(snapshot.usage?.models["Gemini Models"].windows.weekly).toBeDefined();
  });

  test("parses the current tabular fallback", () => {
    const snapshot = parseAgyUsageText("Gemini Models\tWeekly Limit Remaining\t97%\t2026-08-28T01:53:59Z\nGemini Models\tFive Hour Limit Remaining\t95%\t2026-08-25T13:06:20Z\n");
    expect(snapshot.ok).toBe(true);
    expect(snapshot.usage?.windows.weekly.remainingPercent).toBe(97);
    expect(snapshot.usage?.windows["5h"].remainingPercent).toBe(95);
  });
});
