#!/usr/bin/env node

import readline from "node:readline";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("1.1.20\n");
  process.exit(0);
}

if (args[0] === "models") {
  process.stdout.write("fake-model-high\tFake Model (High)\nfake-model-low\tFake Model (Low)\nfake-plain\tFake Plain\n");
  process.exit(0);
}

if (args[0] === "agents" || args[0] === "agent") {
  process.stdout.write("fake-agent\tFake Agent\n");
  process.exit(0);
}

let remembered = "";
let conversationId = "fake-conversation-1";
let turn = 0;
if (args.includes("--conversation")) remembered = "FAKE_MEMORY";

process.stdout.write(JSON.stringify({
  event: "init",
  conversation_id: conversationId,
  init: { cwd: process.cwd(), tools: ["fake_tool"], permission_mode: "request-review" },
}) + "\n");

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: conversationId, status: "ERROR", error: "malformed input" } }) + "\n");
    process.exit(1);
    return;
  }
  const content = message?.message?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content) ? content.map((part) => part?.text ?? "").join("") : "";
  turn += 1;
  if (text.includes("FAKE_AUTH_ERROR")) {
    process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: conversationId, status: "ERROR", error: "authentication required" } }) + "\n");
    return;
  }
  if (text.includes("FAKE_PARTIAL_AUTH")) {
    process.stdout.write(JSON.stringify({ event: "step_update", step_update: { conversation_id: conversationId, step_index: turn, state: "ACTIVE", step_type: "agent_response", text_delta: "PARTIAL" } }) + "\n");
    process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: conversationId, status: "ERROR", error: "authentication required" } }) + "\n");
    return;
  }
  if (text.includes("FAKE_HANG")) return;
  if (text.includes("FAKE_EXIT")) {
    process.exit(1);
    return;
  }
  if (text.includes("remember FAKE_MEMORY")) remembered = "FAKE_MEMORY";
  let response = "FAKE_OK\n";
  if (text.includes("what did you remember")) response = `${remembered || "NOT_REMEMBERED"}\n`;
  if (text.includes("FAKE_STREAM")) response = "FAKE_STREAM_OK\n";
  process.stdout.write(JSON.stringify({ event: "step_update", step_update: { conversation_id: conversationId, step_index: turn, state: "ACTIVE", step_type: "agent_response", text_delta: response.slice(0, -1) } }) + "\n");
  process.stdout.write(JSON.stringify({ event: "step_update", step_update: { conversation_id: conversationId, step_index: turn, state: "DONE", step_type: "agent_response", text_delta: "\n", usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 0, cache_read_tokens: 1, total_tokens: 12 } } }) + "\n");
  process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response, num_turns: turn, usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 0, cache_read_tokens: 1, total_tokens: 12 } } }) + "\n");
});
