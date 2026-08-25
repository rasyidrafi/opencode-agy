import { AgyProtocolError } from "./errors.js";
import { DEFAULT_MAX_NDJSON_LINE_BYTES } from "./constants.js";

export type TextBlock = { type: "text"; text: string };
export type AgyInputEvent = {
  event: "user";
  message: { content: string | TextBlock[] };
};

export type AgyUsage = {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
};

export type AgyInitPayload = {
  cwd?: string;
  tools?: string[];
  permission_mode?: string;
  model?: string;
  agent?: string;
  [key: string]: unknown;
};

export type AgyStepUpdate = {
  conversation_id?: string;
  step_index?: number;
  state?: string;
  step_type?: string;
  text_delta?: string;
  text?: string;
  tool_name?: string;
  tool_info?: {
    name?: string;
    parameters?: unknown;
    output?: unknown;
    error?: unknown;
    [key: string]: unknown;
  };
  subagent_info?: {
    subagents?: unknown;
    [key: string]: unknown;
  };
  usage?: AgyUsage;
  [key: string]: unknown;
};

export type AgyResult = {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: AgyUsage;
  [key: string]: unknown;
};

export type AgyEvent =
  | { event: "init"; conversation_id?: string; init: AgyInitPayload; raw: Record<string, unknown> }
  | { event: "step_update"; step_update: AgyStepUpdate; raw: Record<string, unknown> }
  | { event: "result"; result: AgyResult; raw: Record<string, unknown> }
  | { event: "unknown"; name: string; raw: Record<string, unknown> };

export function encodeUserEvent(content: string | TextBlock[]): string {
  const event: AgyInputEvent = { event: "user", message: { content } };
  return JSON.stringify(event);
}

export function parseNdjsonLine(line: string, maxBytes = DEFAULT_MAX_NDJSON_LINE_BYTES): AgyEvent {
  const size = new TextEncoder().encode(line).byteLength;
  if (size > maxBytes) throw new AgyProtocolError(`agy emitted an oversized NDJSON line (${size} bytes)`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new AgyProtocolError("agy emitted malformed JSON", error);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgyProtocolError("agy emitted a non-object JSON event");
  }
  const raw = parsed as Record<string, unknown>;
  const event = raw.event;
  if (event === "init") {
    if (!raw.init || typeof raw.init !== "object" || Array.isArray(raw.init)) {
      throw new AgyProtocolError("agy init event has no valid init payload");
    }
    return {
      event,
      conversation_id: typeof raw.conversation_id === "string" ? raw.conversation_id : undefined,
      init: raw.init as AgyInitPayload,
      raw,
    };
  }
  if (event === "step_update") {
    if (!raw.step_update || typeof raw.step_update !== "object" || Array.isArray(raw.step_update)) {
      throw new AgyProtocolError("agy step_update event has no valid step_update payload");
    }
    return { event, step_update: raw.step_update as AgyStepUpdate, raw };
  }
  if (event === "result") {
    if (!raw.result || typeof raw.result !== "object" || Array.isArray(raw.result)) {
      throw new AgyProtocolError("agy result event has no valid result payload");
    }
    return { event, result: raw.result as AgyResult, raw };
  }
  if (typeof event === "string" && event.length > 0) {
    return { event: "unknown", name: event, raw };
  }
  throw new AgyProtocolError("agy event is missing its event name");
}

export class NdjsonFramer {
  private buffer = "";
  private readonly maxBytes: number;

  constructor(maxBytes = DEFAULT_MAX_NDJSON_LINE_BYTES) {
    this.maxBytes = maxBytes;
  }

  push(chunk: string): string[] {
    this.buffer += chunk;
    if (new TextEncoder().encode(this.buffer).byteLength > this.maxBytes * 2) {
      throw new AgyProtocolError("agy NDJSON buffer exceeded its safety limit");
    }
    const lines: string[] = [];
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim()) lines.push(line);
      index = this.buffer.indexOf("\n");
    }
    if (new TextEncoder().encode(this.buffer).byteLength > this.maxBytes) {
      throw new AgyProtocolError("agy emitted an unterminated oversized NDJSON line");
    }
    return lines;
  }

  finish(): string[] {
    if (!this.buffer.trim()) return [];
    const line = this.buffer;
    this.buffer = "";
    return [line];
  }
}

export function isSuccessfulResult(event: AgyEvent): boolean {
  return event.event === "result" && String(event.result.status ?? "").toUpperCase() === "SUCCESS";
}

export function resultConversationId(event: AgyEvent): string | undefined {
  if (event.event === "init") return event.conversation_id;
  if (event.event === "step_update") return event.step_update.conversation_id;
  if (event.event === "result") return event.result.conversation_id;
  return undefined;
}
