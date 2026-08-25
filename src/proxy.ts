import { createHash, randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import {
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_REQUEST_READ_TIMEOUT_MS,
  DEFAULT_SSE_HEARTBEAT_MS,
  DIRECTORY_HEADER,
  EFFORT_HEADER,
  AGENT_HEADER,
  LOCAL_API_KEY,
  MODEL_HEADER,
  OPENCODE_AGENT_HEADER,
  REQUEST_TOKEN_HEADER,
  SESSION_HEADER,
  envBoolean,
  envNumber,
  modeForOpenCodeAgent,
} from "./constants.js";
import { detectAgy } from "./cli-detect.js";
import { AgyAbortError, AgyError, AgyProtocolError, asAgyError, retryAfterSeconds } from "./errors.js";
import { debug, error as logError, info, warn } from "./log.js";
import { discoverAgyModels, fallbackAgyModelCatalog, resolveAgyModelSelection, type AgyModelCatalog } from "./models.js";
import { normalizePrompt, sanitizePromptForAgy } from "./prompt.js";
import { detectMetaRequestKind } from "./request-kind.js";
import { buildUtilityPrompt, runAgyOneShot, type OneShotResult } from "./utility.js";
import { bridgePool, type BridgeEvent, type BridgeCall, type HostTool } from "./tool-bridge.js";
import { getAgyUsage } from "./agy-usage.js";
import { sessionPool } from "./session-pool.js";
import type { AgyEvent } from "./protocol.js";
import {
  appendResultWithoutDuplication,
  addOpenAIUsage,
  collectTurn,
  isMeaningfulEvent,
  mapAgyEvent,
  replay,
  type OpenAIUsage,
} from "./translate.js";

export type ChatCompletionRequest = {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  tools?: unknown;
  temperature?: unknown;
  reasoning_effort?: unknown;
  stream_options?: unknown;
  [key: string]: unknown;
};

type RuntimeState = {
  directory: string;
  catalog: AgyModelCatalog;
  startupError?: AgyError;
};

type ProbeResult =
  | { replay: AsyncIterable<AgyEvent> }
  | { error: AgyError };

type BridgeProbeResult =
  | { replay: AsyncIterable<BridgeEvent>; parked: boolean }
  | { error: AgyError };

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

let server: ReturnType<typeof Bun.serve> | null = null;
let proxyPort: number | null = null;
let runtime: RuntimeState | null = null;
let startPromise: Promise<number> | null = null;

function requestedPort(): number {
  const value = Number(process.env.OPENCODE_AGY_PROXY_PORT);
  return Number.isInteger(value) && value >= 0 && value < 65_536 ? value : 0;
}

function readHeader(request: Request, name: string): string | undefined {
  const value = request.headers.get(name)?.trim();
  return value ? value : undefined;
}

function shortHeader(value: string | undefined, max = 300): string | undefined {
  if (!value) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

function sessionKey(request: Request, messages: unknown): string {
  const header = readHeader(request, SESSION_HEADER);
  // OpenCode supplies the session header. Without it there is no reliable
  // opaque identity to persist: hashing only the first prompt would make two
  // unrelated chats with the same opening line share an agent conversation.
  // Hash the complete request instead; subsequent requests can transfer their
  // bounded text history without sharing state with another client.
  const seed = header
    ? `session:${header}`
    : `request:${JSON.stringify(messages)}`;
  return createHash("sha256").update(seed).digest("hex");
}

function localAuthorizationIsValid(request: Request): boolean {
  const bearer = request.headers.get("authorization")?.trim();
  const token = readHeader(request, REQUEST_TOKEN_HEADER);
  return bearer === `Bearer ${LOCAL_API_KEY}` || token === LOCAL_API_KEY;
}

async function readJson(request: Request): Promise<ChatCompletionRequest> {
  const max = envNumber("OPENCODE_AGY_MAX_REQUEST_BYTES", DEFAULT_MAX_REQUEST_BYTES, 1_024);
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > max) {
    throw new AgyError("invalid_request", "The request body is too large", { code: "agy_request_too_large", status: 413 });
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    const readTimeoutMs = envNumber("OPENCODE_AGY_REQUEST_READ_TIMEOUT_MS", DEFAULT_REQUEST_READ_TIMEOUT_MS, 1_000);
    const deadline = Date.now() + readTimeoutMs;
    try {
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new AgyError("timeout", "Timed out while reading the request body", { code: "agy_request_read_timeout" });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const next = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new AgyError("timeout", "Timed out while reading the request body", { code: "agy_request_read_timeout" })), remaining);
              timer.unref?.();
            }),
          ]);
          if (next.done) break;
          total += next.value.byteLength;
          if (total > max) {
            await reader.cancel("request body too large");
            throw new AgyError("invalid_request", "The request body is too large", { code: "agy_request_too_large", status: 413 });
          }
          chunks.push(next.value);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch (error) {
    throw new AgyError("invalid_request", "The request body is not valid JSON", { code: "agy_invalid_json", cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgyError("invalid_request", "The request body must be a JSON object", { code: "agy_request_object" });
  }
  return parsed as ChatCompletionRequest;
}

function errorResponse(error: unknown): Response {
  const failure = asAgyError(error);
  const retryAfter = retryAfterSeconds(failure);
  const payload = {
    error: {
      message: failure.message,
      type: failure.kind === "auth" ? "authentication_error" :
        failure.kind === "quota" ? "rate_limit_error" :
          failure.kind === "invalid_request" || failure.kind === "unsupported" || failure.kind === "unknown_model"
            ? "invalid_request_error"
            : "server_error",
      code: failure.code,
      ...(failure.retryable ? { retryable: true } : {}),
      ...(failure.details?.available ? { available_models: failure.details.available } : {}),
    },
  };
  return Response.json(payload, {
    status: failure.status,
    headers: retryAfter ? { "Retry-After": String(retryAfter) } : undefined,
  });
}

function openAIUsage(usage: OpenAIUsage | undefined): Record<string, unknown> | undefined {
  return usage ? { ...usage } : undefined;
}

async function probeTurn(events: AsyncIterable<AgyEvent>): Promise<ProbeResult> {
  const iterator = events[Symbol.asyncIterator]();
  const buffered: AgyEvent[] = [];
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      const event = next.value;
      if (event.event === "result") {
        const mapped = mapAgyEvent(event);
        if (mapped.kind === "error") {
          await iterator.return?.();
          return { error: mapped.error };
        }
        buffered.push(event);
        return { replay: replay(buffered, iterator) };
      }
      buffered.push(event);
      if (isMeaningfulEvent(event)) return { replay: replay(buffered, iterator) };
    }
  } catch (error) {
    await iterator.return?.();
    return { error: asAgyError(error, "The agy process ended before producing a response") };
  }
  return { error: new AgyProtocolError("The agy process ended without a response") };
}

function bridgeEventIsMeaningful(event: BridgeEvent): boolean {
  if (event.kind === "tool_call") return true;
  return isMeaningfulEvent(event.event) || event.event.event === "result";
}

async function probeBridgeTurn(events: AsyncIterable<BridgeEvent>): Promise<BridgeProbeResult> {
  const iterator = events[Symbol.asyncIterator]();
  const buffered: BridgeEvent[] = [];
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      const event = next.value;
      buffered.push(event);
      if (event.kind === "tool_call") return { replay: replay(buffered, iterator), parked: true };
      const mapped = mapAgyEvent(event.event);
      if (mapped.kind === "error") {
        await iterator.return?.();
        return { error: mapped.error };
      }
      if (bridgeEventIsMeaningful(event)) return { replay: replay(buffered, iterator), parked: false };
    }
  } catch (error) {
    await iterator.return?.();
    return { error: asAgyError(error, "The agy bridge turn ended before producing a response") };
  }
  return { error: new AgyProtocolError("The agy bridge turn ended without a response") };
}

function textToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").join("");
}

function toolResultsFromMessages(messages: unknown): Array<{ id: string; value: string }> {
  if (!Array.isArray(messages)) return [];
  const result: Array<{ id: string; value: string }> = [];
  for (const item of messages) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const message = item as Record<string, unknown>;
    if (message.role !== "tool" || typeof message.tool_call_id !== "string") continue;
    result.push({ id: message.tool_call_id, value: textToolResult(message.content) });
  }
  return result;
}

type CollectedBridgeTurn = {
  content: string;
  reasoning: string;
  usage?: OpenAIUsage;
  toolCall?: BridgeCall;
};

async function collectBridgeTurn(events: AsyncIterable<BridgeEvent>): Promise<CollectedBridgeTurn> {
  let content = "";
  let reasoning = "";
  let stepUsage: OpenAIUsage | undefined;
  let resultUsage: OpenAIUsage | undefined;
  for await (const event of events) {
    if (event.kind === "tool_call") return { content, reasoning, ...(stepUsage ? { usage: stepUsage } : {}), toolCall: event.call };
    const mapped = mapAgyEvent(event.event);
    if (mapped.kind === "text") content += mapped.text;
    else if (mapped.kind === "reasoning") reasoning += mapped.text;
    else if (mapped.kind === "usage") stepUsage = addOpenAIUsage(stepUsage, mapped.usage);
    else if (mapped.kind === "result") resultUsage = mapped.usage;
    else if (mapped.kind === "error") throw mapped.error;
  }
  return { content, reasoning, usage: stepUsage ?? resultUsage };
}

function streamBridgeCompletion(
  key: string,
  turn: import("./tool-bridge.js").BridgeTurn,
  events: AsyncIterable<BridgeEvent>,
  model: string,
  signal?: AbortSignal,
): Response {
  const id = completionId();
  const created = Math.floor(Date.now() / 1_000);
  const encoder = new TextEncoder();
  let closed = false;
  let iterator: AsyncIterator<BridgeEvent> | undefined;
  let keepParked = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      iterator = events[Symbol.asyncIterator]();
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      let streamedText = "";
      let stepUsage: OpenAIUsage | undefined;
      let resultUsage: OpenAIUsage | undefined;
      let finishReason = "stop";
      try {
        send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
        while (true) {
          if (signal?.aborted) throw new AgyAbortError();
          const next = await iterator.next();
          if (next.done) break;
          const event = next.value;
          if (event.kind === "tool_call") {
            keepParked = true;
            finishReason = "tool_calls";
            send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: event.call.id, type: "function", function: { name: event.call.name, arguments: event.call.arguments } }] }, finish_reason: null }] });
            break;
          }
          const mapped = mapAgyEvent(event.event);
          if (mapped.kind === "text") {
            streamedText += mapped.text;
            send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: mapped.text }, finish_reason: null }] });
          } else if (mapped.kind === "reasoning") {
            send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { reasoning_content: mapped.text }, finish_reason: null }] });
          } else if (mapped.kind === "usage") stepUsage = addOpenAIUsage(stepUsage, mapped.usage);
          else if (mapped.kind === "result") {
            resultUsage = mapped.usage;
            const suffix = appendResultWithoutDuplication(streamedText, mapped.response);
            if (suffix === undefined) throw new AgyProtocolError("agy bridge deltas did not match its terminal response");
            if (suffix) {
              streamedText += suffix;
              send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: suffix }, finish_reason: null }] });
            }
          } else if (mapped.kind === "error") throw mapped.error;
        }
        const usage = stepUsage ?? resultUsage;
        send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], ...(openAIUsage(usage) ? { usage: openAIUsage(usage) } : {}) });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        keepParked = false;
        if (!closed) {
          const failure = asAgyError(error);
          send({ error: { message: failure.message, type: failure.kind === "auth" ? "authentication_error" : failure.kind === "quota" ? "rate_limit_error" : "server_error", code: failure.code } });
          try { controller.close(); } catch { /* disconnected */ }
        }
      } finally {
        closed = true;
        await iterator?.return?.();
        if (!keepParked) await bridgePool.finish(key, turn);
      }
    },
    async cancel() {
      closed = true;
      keepParked = false;
      await iterator?.return?.();
      await bridgePool.finish(key, turn);
    },
  });
  return new Response(body, { headers: SSE_HEADERS });
}

function completionId(): string {
  return `chatcmpl_${randomUUID().replace(/-/g, "")}`;
}

function completionModel(bodyModel: string | undefined, selected: string): string {
  return bodyModel || `${"antigravity-cli"}/${selected}`;
}

function ssePayload(controller: ReadableStreamDefaultController<Uint8Array>, encoder: TextEncoder, payload: unknown): void {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
}

function streamCompletion(
  events: AsyncIterable<AgyEvent>,
  model: string,
  signal?: AbortSignal,
): Response {
  const id = completionId();
  const created = Math.floor(Date.now() / 1_000);
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let iterator: AsyncIterator<AgyEvent> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      iterator = events[Symbol.asyncIterator]();
      heartbeat = setInterval(() => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            closed = true;
          }
        }
      }, envNumber("OPENCODE_AGY_SSE_HEARTBEAT_MS", DEFAULT_SSE_HEARTBEAT_MS, 1_000));
      heartbeat.unref?.();
      let streamedText = "";
      let stepUsage: OpenAIUsage | undefined;
      let resultUsage: OpenAIUsage | undefined;
      let finishReason = "stop";
      let failed = false;
      try {
        ssePayload(controller, encoder, {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        });
        while (true) {
          if (signal?.aborted) throw new AgyError("timeout", "The client cancelled the agy request", { status: 499, code: "agy_client_cancelled", retryable: false });
          const next = await iterator!.next();
          if (next.done) break;
          const mapped = mapAgyEvent(next.value);
          if (mapped.kind === "text") {
            streamedText += mapped.text;
            ssePayload(controller, encoder, {
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { content: mapped.text }, finish_reason: null }],
            });
          } else if (mapped.kind === "reasoning") {
            ssePayload(controller, encoder, {
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { reasoning_content: mapped.text }, finish_reason: null }],
            });
          } else if (mapped.kind === "usage") {
            stepUsage = addOpenAIUsage(stepUsage, mapped.usage);
          } else if (mapped.kind === "result") {
            resultUsage = mapped.usage;
            const suffix = appendResultWithoutDuplication(streamedText, mapped.response);
            if (suffix === undefined) {
              failed = true;
              ssePayload(controller, encoder, {
                error: {
                  message: "agy stream deltas did not match its terminal response",
                  type: "server_error",
                  code: "agy_protocol_error",
                },
              });
              break;
            }
            if (suffix) {
              streamedText += suffix;
              ssePayload(controller, encoder, {
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { content: suffix }, finish_reason: null }],
              });
            }
          } else if (mapped.kind === "error") {
            finishReason = "stop";
            failed = true;
            ssePayload(controller, encoder, {
              error: {
                message: mapped.error.message,
                type: mapped.error.kind === "quota" ? "rate_limit_error" : mapped.error.kind === "auth" ? "authentication_error" : "server_error",
                code: mapped.error.code,
                ...(mapped.error.retryable ? { retryable: true } : {}),
              },
            });
            break;
          }
        }
        const usage = stepUsage ?? resultUsage;
        if (!closed && !failed) {
          ssePayload(controller, encoder, {
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            ...(openAIUsage(usage) ? { usage: openAIUsage(usage) } : {}),
          });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } else if (!closed) {
          controller.close();
        }
      } catch (error) {
        if (!closed) {
          const failure = asAgyError(error);
          ssePayload(controller, encoder, {
            error: {
              message: failure.message,
              type: failure.kind === "auth" ? "authentication_error" : failure.kind === "quota" ? "rate_limit_error" : "server_error",
              code: failure.code,
              ...(failure.retryable ? { retryable: true } : {}),
            },
          });
          try {
            controller.close();
          } catch {
            // Client disconnected.
          }
        }
      } finally {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        await iterator?.return?.();
      }
    },
    async cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      await iterator?.return?.();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

function modelList(catalog: AgyModelCatalog): Response {
  return Response.json({
    object: "list",
    data: catalog.models.map((model) => ({
      id: model.id,
      object: "model",
      created: Math.floor(catalog.discoveredAt / 1_000),
      owned_by: "google-antigravity",
    })),
  });
}

function utilityCompletion(result: OneShotResult, model: string, stream: boolean): Response {
  const id = completionId();
  const created = Math.floor(Date.now() / 1_000);
  if (!stream) {
    return Response.json({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: result.response }, finish_reason: "stop" }],
      ...(openAIUsage(result.usage) ? { usage: openAIUsage(result.usage) } : {}),
    });
  }
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      if (result.response) send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: result.response }, finish_reason: null }] });
      send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(openAIUsage(result.usage) ? { usage: openAIUsage(result.usage) } : {}) });
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { headers: SSE_HEADERS });
}

async function serveBridgeTurn(
  key: string,
  turn: import("./tool-bridge.js").BridgeTurn,
  request: Request,
  body: ChatCompletionRequest,
  outputModel: string,
): Promise<Response> {
  const probed = await probeBridgeTurn(turn.events(request.signal));
  if ("error" in probed) {
    await bridgePool.finish(key, turn);
    return errorResponse(probed.error);
  }
  if (body.stream === true) return streamBridgeCompletion(key, turn, probed.replay, outputModel, request.signal);
  try {
    const collected = await collectBridgeTurn(probed.replay);
    if (collected.toolCall) {
      return Response.json({
        id: completionId(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1_000),
        model: outputModel,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: collected.toolCall.id, type: "function", function: { name: collected.toolCall.name, arguments: collected.toolCall.arguments } }],
          },
          finish_reason: "tool_calls",
        }],
      });
    }
    await bridgePool.finish(key, turn);
    return Response.json({
      id: completionId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1_000),
      model: outputModel,
      choices: [{ index: 0, message: { role: "assistant", content: collected.content, ...(collected.reasoning ? { reasoning_content: collected.reasoning } : {}) }, finish_reason: "stop" }],
      ...(openAIUsage(collected.usage) ? { usage: openAIUsage(collected.usage) } : {}),
    });
  } catch (error) {
    await bridgePool.finish(key, turn);
    return errorResponse(error);
  }
}

async function handleChat(request: Request, body: ChatCompletionRequest): Promise<Response> {
  if (!runtime) throw new AgyError("internal", "The agy proxy runtime is not initialized", { code: "agy_runtime_uninitialized" });
  if (runtime.startupError) throw runtime.startupError;
  const key = sessionKey(request, body.messages);
  const existingBridge = bridgePool.get(key);
  const bridgeEnabled = envBoolean("OPENCODE_AGY_TOOL_BRIDGE", false) && (Boolean(existingBridge) || (Array.isArray(body.tools) && body.tools.length > 0));
  if (!bridgeEnabled && body.tool_choice !== undefined && body.tool_choice !== null && body.tool_choice !== "none" && body.tool_choice !== "auto") {
    throw new AgyError("unsupported", "OpenCode tool-call continuation is not supported by the MVP", { code: "agy_tool_choice_unsupported" });
  }
  // OpenCode may include its ordinary tool definitions even when this model
  // advertises toolcall=false. They are metadata only here: never forward
  // them as callbacks and never claim that Antigravity executed them.
  const bodyModel = typeof body.model === "string" ? body.model : undefined;
  const headerModel = readHeader(request, MODEL_HEADER);
  const requestedModel = headerModel || bodyModel;
  const requestedEffort = readHeader(request, EFFORT_HEADER) ||
    (typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined);
  const selected = resolveAgyModelSelection(requestedModel, requestedEffort, runtime.catalog);
  const cwd = resolvePath(readHeader(request, DIRECTORY_HEADER) || runtime.directory);
  const agent = shortHeader(readHeader(request, AGENT_HEADER) || process.env.OPENCODE_AGY_AGENT, 200);
  const openCodeAgent = shortHeader(readHeader(request, OPENCODE_AGENT_HEADER), 200);
  const mode = modeForOpenCodeAgent(openCodeAgent, process.env.OPENCODE_AGY_MODE);
  const settings = {
    cwd,
    model: selected.cliModel,
    ...(selected.effort ? { effort: selected.effort } : {}),
    ...(agent ? { agent } : {}),
    ...(mode ? { mode } : {}),
    sandbox: envBoolean("OPENCODE_AGY_SANDBOX", false),
    dangerouslySkipPermissions: envBoolean("OPENCODE_AGY_DANGEROUSLY_SKIP_PERMISSIONS", false),
    cliVersion: runtime.catalog.version,
    executable: runtime.catalog.executable,
  } as const;
  if (existingBridge) {
    const results = toolResultsFromMessages(body.messages);
    if (!results.length) throw new AgyError("invalid_request", "The bridged Antigravity turn is waiting for OpenCode tool results", { code: "agy_bridge_missing_tool_result" });
    let resolved = 0;
    for (const result of results) if (bridgePool.resolve(key, result.id, result.value)) resolved += 1;
    if (!resolved) throw new AgyError("invalid_request", "No pending bridged tool call matched the OpenCode tool result", { code: "agy_bridge_unknown_call" });
    return serveBridgeTurn(key, existingBridge, request, body, completionModel(bodyModel, selected.requestedModel));
  }
  const normalized = normalizePrompt(body.messages);
  const metaKind = detectMetaRequestKind(normalized.messages);
  if (metaKind) {
    try {
      const utility = await runAgyOneShot(buildUtilityPrompt(metaKind, normalized.messages), {
        cwd,
        model: selected.cliModel,
        ...(selected.effort ? { effort: selected.effort } : {}),
        sandbox: settings.sandbox,
        executable: settings.executable,
        signal: request.signal,
      });
      return utilityCompletion(utility, completionModel(bodyModel, selected.requestedModel), body.stream === true);
    } catch (error) {
      return errorResponse(error);
    }
  }
  const outputModel = completionModel(bodyModel, selected.requestedModel);
  if (bridgeEnabled) {
    const endpoint = `http://127.0.0.1:${proxyPort}/internal/mcp`;
    const turn = await bridgePool.start(key, sanitizePromptForAgy(normalized.text), settings, body.tools as HostTool[], endpoint, request.signal);
    return serveBridgeTurn(key, turn, request, body, outputModel);
  }
  const events = sessionPool.turn({
    key,
    prompt: sanitizePromptForAgy(normalized.text),
    priorMessages: normalized.priorMessages,
    settings,
    signal: request.signal,
  });
  const stream = body.stream === true;
  if (stream) {
    const probed = await probeTurn(events);
    if ("error" in probed) return errorResponse(probed.error);
    return streamCompletion(probed.replay, outputModel, request.signal);
  }
  try {
    const collected = await collectTurn(events);
    return Response.json({
      id: completionId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1_000),
      model: outputModel,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: collected.content,
          ...(collected.reasoning ? { reasoning_content: collected.reasoning } : {}),
        },
        finish_reason: "stop",
      }],
      ...(openAIUsage(collected.usage) ? { usage: openAIUsage(collected.usage) } : {}),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const requiresLocalKey = (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) ||
    (request.method === "GET" && (url.pathname === "/v1/usage" || url.pathname === "/usage")) ||
    (request.method === "POST" && url.pathname === "/v1/chat/completions");
  if (requiresLocalKey && !localAuthorizationIsValid(request)) {
    return errorResponse(new AgyError("auth", "Invalid local proxy API key", { code: "agy_local_key" }));
  }
  if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
    return Response.json({
      ok: !runtime?.startupError,
      provider: "antigravity-cli",
      proxy: "loopback",
      port: proxyPort,
      agy: {
        executable: runtime?.catalog.executable,
        version: runtime?.catalog.version,
        models_source: runtime?.catalog.source,
        ready: !runtime?.startupError,
        ...(runtime?.startupError ? { error: runtime.startupError.message } : {}),
      },
    });
  }
  if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
    return modelList(runtime?.catalog ?? fallbackAgyModelCatalog());
  }
  if (request.method === "GET" && (url.pathname === "/v1/usage" || url.pathname === "/usage")) {
    return Response.json(await getAgyUsage(runtime?.directory ?? process.cwd()));
  }
  if (request.method === "POST" && url.pathname === "/internal/mcp") {
    try {
      const payload: unknown = await request.json();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new AgyError("invalid_request", "Invalid bridge request", { code: "agy_bridge_request" });
      const body = payload as Record<string, unknown>;
      const message = body.message && typeof body.message === "object" && !Array.isArray(body.message) ? body.message as Record<string, unknown> : undefined;
      if (!message) throw new AgyError("invalid_request", "Invalid MCP JSON-RPC message", { code: "agy_bridge_rpc" });
      const result = await bridgePool.rpc(String(body.bridgeId ?? ""), String(body.token ?? ""), message);
      return Response.json(result);
    } catch (error) {
      return errorResponse(error);
    }
  }
  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    try {
      return await handleChat(request, await readJson(request));
    } catch (error) {
      logError("chat request failed", { kind: error instanceof AgyError ? error.kind : "internal" });
      return errorResponse(error);
    }
  }
  return new Response("Not Found", { status: 404 });
}

async function startProxyInternal(directory: string): Promise<number> {
  if (server && proxyPort) return proxyPort;
  sessionPool.open();
  let catalog: AgyModelCatalog;
  let startupError: AgyError | undefined;
  try {
    catalog = await discoverAgyModels(false, directory);
  } catch (error) {
    startupError = asAgyError(error, "The official agy CLI is unavailable");
    warn("starting proxy without a usable agy CLI", { kind: startupError.kind });
    catalog = fallbackAgyModelCatalog();
  }
  runtime = { directory, catalog, ...(startupError ? { startupError } : {}) };
  const bound = Bun.serve({
    hostname: "127.0.0.1",
    port: requestedPort(),
    idleTimeout: 0,
    fetch: handleRequest,
  });
  server = bound;
  proxyPort = bound.port ?? null;
  if (!proxyPort) throw new AgyError("internal", "The loopback agy proxy did not receive a port", { code: "agy_proxy_no_port" });
  info("agy loopback proxy listening", { port: proxyPort, models: catalog.models.length, ready: !startupError });
  return proxyPort;
}

export async function startProxy(directory = process.cwd()): Promise<number> {
  if (server && proxyPort) return proxyPort;
  if (!startPromise) {
    startPromise = startProxyInternal(resolvePath(directory)).finally(() => {
      startPromise = null;
    });
  }
  return startPromise;
}

export async function stopProxy(): Promise<void> {
  if (server) {
    server.stop(true);
    server = null;
    proxyPort = null;
  }
  runtime = null;
  await bridgePool.close();
  await sessionPool.close();
}

export function getProxyPort(): number | null {
  return proxyPort;
}

export function getProxyBaseUrl(): string {
  if (!proxyPort) throw new AgyError("internal", "The agy proxy is not listening", { code: "agy_proxy_not_started" });
  return `http://127.0.0.1:${proxyPort}/v1`;
}

export function getProxyRuntime(): RuntimeState | null {
  return runtime;
}

export async function refreshModels(): Promise<AgyModelCatalog> {
  const directory = runtime?.directory ?? process.cwd();
  const catalog = await discoverAgyModels(true, directory);
  if (runtime) {
    runtime.catalog = catalog;
    delete runtime.startupError;
  }
  return catalog;
}
