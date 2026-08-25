import { describe, expect, test } from "bun:test";
import { AgyProtocolError } from "../src/errors.js";
import { NdjsonFramer, parseNdjsonLine } from "../src/protocol.js";

describe("agy NDJSON protocol", () => {
  test("parses documented init, step, and result events", () => {
    const init = parseNdjsonLine('{"event":"init","conversation_id":"c","init":{"cwd":"/tmp","tools":[]}}');
    const step = parseNdjsonLine('{"event":"step_update","step_update":{"text_delta":"hello"}}');
    const result = parseNdjsonLine('{"event":"result","result":{"status":"SUCCESS","response":"hello"}}');
    expect(init.event).toBe("init");
    expect(step.event).toBe("step_update");
    expect(result.event).toBe("result");
  });

  test("preserves forward-compatible unknown events", () => {
    const event = parseNdjsonLine('{"event":"future_event","value":1}');
    expect(event).toEqual({ event: "unknown", name: "future_event", raw: { event: "future_event", value: 1 } });
  });

  test("rejects malformed and oversized events", () => {
    expect(() => parseNdjsonLine("not-json")).toThrow(AgyProtocolError);
    expect(() => parseNdjsonLine('{"event":"init"}')).toThrow(AgyProtocolError);
    expect(() => parseNdjsonLine('{"event":"result","result":{}}', 10)).toThrow(AgyProtocolError);
  });

  test("frames partial lines and multievent chunks", () => {
    const framer = new NdjsonFramer();
    expect(framer.push('{"event":"future"}\n{"event":"res')).toEqual(['{"event":"future"}']);
    expect(framer.push('ult","result":{}}\n')).toEqual(['{"event":"result","result":{}}']);
  });
});
