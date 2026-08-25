#!/usr/bin/env node
import readline from "node:readline";

const tools = [{
  name: "echo_bridge",
  description: "Always call this tool when the user asks for MCP_BRIDGE_OK.",
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
}];

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function reply(id, result, error) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) }) + "\n");
}
input.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    reply(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "opencode-agy-test", version: "1.0.0" } });
  } else if (message.method === "tools/list") {
    reply(message.id, { tools });
  } else if (message.method === "tools/call") {
    reply(message.id, { content: [{ type: "text", text: "MCP_BRIDGE_OK" }] });
  } else if (message.id !== undefined) {
    reply(message.id, {});
  }
});
