import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BridgeSession, normalizeBridgeTools } from "../src/tool-bridge.js";

describe("opt-in MCP bridge protocol", () => {
  test("normalizes bounded host tool definitions", () => {
    const tools = normalizeBridgeTools([{ type: "function", function: { name: "echo_bridge", description: "Echo", parameters: { type: "object" } } }]);
    expect(tools).toHaveLength(1);
    expect(tools[0].originalName).toBe("echo_bridge");
    expect(tools[0].mcpName).toBe("echo_bridge");
  });

  test("handles discovery, listing, correlated calls, and results", async () => {
    const bridge = new BridgeSession(normalizeBridgeTools([{ type: "function", function: { name: "echo_bridge", parameters: { type: "object" } } }]));
    const discovered = await bridge.rpc({ jsonrpc: "2.0", id: 1, method: "server/discover" });
    expect(discovered.result).toEqual({});
    const listed = await bridge.rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((listed.result as { tools: unknown[] }).tools).toHaveLength(1);
    const pending = bridge.rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo_bridge", arguments: { value: "x" } } });
    const call = await bridge.nextCall();
    expect(call.name).toBe("echo_bridge");
    expect(bridge.resolve(call.id, "MCP_BRIDGE_OK")).toBe(true);
    const result = await pending;
    expect((result.result as { content: Array<{ text: string }> }).content[0].text).toBe("MCP_BRIDGE_OK");
    await bridge.close();
  });

  test("writes only a restrictive temporary workspace config", async () => {
    const previous = process.env.OPENCODE_AGY_MCP_BRIDGE_SCRIPT;
    process.env.OPENCODE_AGY_MCP_BRIDGE_SCRIPT = join(process.cwd(), "dist", "mcp-bridge.js");
    const bridge = new BridgeSession(normalizeBridgeTools([{ type: "function", function: { name: "echo_bridge", parameters: { type: "object" } } }]));
    const overlay = await bridge.prepare("http://127.0.0.1:1/internal/mcp");
    const config = JSON.parse(await readFile(join(overlay, ".agents", "mcp_config.json"), "utf8"));
    expect(config.mcpServers).toBeDefined();
    expect(JSON.stringify(config)).not.toContain("OPENCODE_AGY_BRIDGE_TOKEN");
    await bridge.close();
    await expect(readFile(join(overlay, ".agents", "mcp_config.json"))).rejects.toThrow();
    if (previous === undefined) delete process.env.OPENCODE_AGY_MCP_BRIDGE_SCRIPT;
    else process.env.OPENCODE_AGY_MCP_BRIDGE_SCRIPT = previous;
  });
});
