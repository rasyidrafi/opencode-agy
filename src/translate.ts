import { AgyError, failureFromCliResult } from "./errors.js";
import type { AgyEvent, AgyResult, AgyStepUpdate, AgyUsage } from "./protocol.js";

export type OpenAIUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
};

export type MappedAgyEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "usage"; usage: OpenAIUsage }
  | { kind: "result"; result: AgyResult; response: string; usage?: OpenAIUsage }
  | { kind: "error"; error: AgyError; usage?: OpenAIUsage }
  | { kind: "ignore" };

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

export function usageFromAgy(usage: AgyUsage | undefined): OpenAIUsage | undefined {
  if (!usage) return undefined;
  const prompt = nonNegativeInteger(usage.input_tokens) ?? 0;
  const completion = nonNegativeInteger(usage.output_tokens) ?? 0;
  const thinking = nonNegativeInteger(usage.thinking_tokens);
  const cached = nonNegativeInteger(usage.cache_read_tokens);
  const total = nonNegativeInteger(usage.total_tokens) ?? prompt + completion;
  if (prompt === 0 && completion === 0 && total === 0 && cached === undefined) return undefined;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Math.max(total, prompt + completion),
    ...(cached !== undefined ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    ...(thinking !== undefined ? { completion_tokens_details: { reasoning_tokens: thinking } } : {}),
  };
}

export function addOpenAIUsage(left: OpenAIUsage | undefined, right: OpenAIUsage | undefined): OpenAIUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  const cached = (left.prompt_tokens_details?.cached_tokens ?? 0) + (right.prompt_tokens_details?.cached_tokens ?? 0);
  const reasoning = (left.completion_tokens_details?.reasoning_tokens ?? 0) + (right.completion_tokens_details?.reasoning_tokens ?? 0);
  return {
    prompt_tokens: left.prompt_tokens + right.prompt_tokens,
    completion_tokens: left.completion_tokens + right.completion_tokens,
    total_tokens: left.total_tokens + right.total_tokens,
    ...(cached ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    ...(reasoning ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
  };
}

function toolStatus(step: AgyStepUpdate): string | undefined {
  const info = step.tool_info;
  const name = typeof info?.name === "string" && info.name ? info.name :
    typeof step.tool_name === "string" && step.tool_name ? step.tool_name : undefined;
  if (!name && step.step_type !== "tool") return undefined;
  const state = typeof step.state === "string" ? step.state.toLowerCase() : "";
  return `[agy tool${name ? `: ${name}` : ""}${state ? ` (${state})` : ""}]\n`;
}

function subagentStatus(step: AgyStepUpdate): string | undefined {
  if (!step.subagent_info) return undefined;
  const list = Array.isArray(step.subagent_info.subagents) ? step.subagent_info.subagents.length : undefined;
  return `[agy subagent activity${list === undefined ? "" : ` (${list} subagent${list === 1 ? "" : "s"})`}]\n`;
}

export function mapAgyEvent(event: AgyEvent): MappedAgyEvent {
  if (event.event === "init" || event.event === "unknown") return { kind: "ignore" };
  if (event.event === "step_update") {
    const step = event.step_update;
    if (typeof step.text_delta === "string" && step.text_delta) return { kind: "text", text: step.text_delta };
    if (typeof step.text === "string" && step.text) return { kind: "text", text: step.text };
    const tool = toolStatus(step);
    if (tool) return { kind: "reasoning", text: tool };
    const subagent = subagentStatus(step);
    if (subagent) return { kind: "reasoning", text: subagent };
    const usage = usageFromAgy(step.usage);
    if (usage) return { kind: "usage", usage };
    return { kind: "ignore" };
  }
  const result = event.result;
  const usage = usageFromAgy(result.usage);
  const failure = failureFromCliResult(result);
  if (failure) return { kind: "error", error: failure, usage };
  return {
    kind: "result",
    result,
    response: typeof result.response === "string" ? result.response : "",
    ...(usage ? { usage } : {}),
  };
}

export function resultFailure(event: AgyEvent): AgyError | undefined {
  if (event.event !== "result") return undefined;
  return failureFromCliResult(event.result);
}

export function isMeaningfulEvent(event: AgyEvent): boolean {
  const mapped = mapAgyEvent(event);
  return mapped.kind === "text" || mapped.kind === "reasoning" ||
    (mapped.kind === "result" && Boolean(mapped.response));
}

export type CollectedTurn = {
  content: string;
  reasoning: string;
  usage?: OpenAIUsage;
  result: AgyResult;
};

export async function collectTurn(events: AsyncIterable<AgyEvent>): Promise<CollectedTurn> {
  let streamedText = "";
  let reasoning = "";
  let stepUsage: OpenAIUsage | undefined;
  let resultUsage: OpenAIUsage | undefined;
  let result: AgyResult | undefined;
  for await (const event of events) {
    const mapped = mapAgyEvent(event);
    if (mapped.kind === "text") streamedText += mapped.text;
    else if (mapped.kind === "reasoning") reasoning += mapped.text;
    else if (mapped.kind === "usage") stepUsage = addOpenAIUsage(stepUsage, mapped.usage);
    else if (mapped.kind === "error") throw mapped.error;
    else if (mapped.kind === "result") {
      result = mapped.result;
      resultUsage = mapped.usage;
    }
  }
  if (!result) throw new AgyError("protocol", "agy ended a turn without a result", { code: "agy_missing_result" });
  const authoritative = typeof result.response === "string" ? result.response : streamedText;
  const usage = stepUsage ?? resultUsage;
  return { content: authoritative, reasoning, ...(usage ? { usage } : {}), result };
}

/** If a CLI emitted deltas, avoid appending the full result a second time. */
export function appendResultWithoutDuplication(streamed: string, result: string): string | undefined {
  if (!result) return "";
  if (!streamed) return result;
  if (result === streamed) return "";
  if (result.startsWith(streamed)) return result.slice(streamed.length);
  return undefined;
}

export async function* replay<T>(buffered: T[], rest: AsyncIterator<T>): AsyncGenerator<T> {
  for (const item of buffered) yield item;
  try {
    while (true) {
      const next = await rest.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await rest.return?.();
  }
}
