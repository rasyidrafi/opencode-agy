/**
 * Stdio MCP adapter launched by the official agy CLI when the opt-in host-tool
 * bridge is enabled. It intentionally contains no host-tool implementation:
 * calls are correlated through the plugin's loopback endpoint.
 */
import readline from "node:readline";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const endpoint = process.env.OPENCODE_AGY_BRIDGE_URL;
const token = process.env.OPENCODE_AGY_BRIDGE_TOKEN;
const bridgeId = argument("--bridge-id");

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorResponse(id: unknown, message: string): void {
  write({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  let message: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    message = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  if (message.id === undefined || message.method === "notifications/initialized") return;
  if (!endpoint || !token || !bridgeId) {
    errorResponse(message.id, "The opencode-agy MCP bridge is not configured");
    return;
  }
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bridgeId, token, message }),
    });
    const body: unknown = await response.json();
    if (!response.ok || !body || typeof body !== "object") {
      errorResponse(message.id, "The opencode-agy bridge endpoint rejected the MCP request");
      return;
    }
    write(body);
  } catch {
    errorResponse(message.id, "The opencode-agy bridge endpoint is unavailable");
  }
});
