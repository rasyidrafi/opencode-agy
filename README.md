# opencode-agy

`opencode-agy` is an OpenCode provider plugin that runs Antigravity through
Google's official `agy` executable. It does **not** implement Antigravity's
private HTTP protocol and it does not handle Google credentials.

## What it does

```text
OpenCode → localhost OpenAI-compatible proxy → agy NDJSON subprocess → Antigravity
```

The plugin provides:

- text streaming and non-streaming `/v1/chat/completions`;
- dynamic model discovery from `agy models` (including effort variants);
- low/medium/high effort selection;
- one persistent `agy` worker per OpenCode session;
- conversation resume using only the CLI's conversation ID;
- bounded history transfer when a saved conversation is unavailable;
- usage, Antigravity tool activity, and subagent activity as non-tool telemetry;
- bounded subprocess I/O, backpressure, cancellation, timeouts, protocol checks,
  truthful HTTP errors, and redacted diagnostics;
- text-only capability declarations.

The official `agy models` output currently provides model slugs, display names,
and effort tiers, but does not publish context-window or maximum-output-token
limits. For canonical model matches, the plugin uses a curated metadata table
backed by Models.dev and Google's public Gemini API documentation; unknown
models leave limits unset. These are model-family facts, not a claim that every
Antigravity subscription route exposes the same provider limits.

The plugin never reads, parses, copies, refreshes, stores, or logs OAuth
credentials. The child process inherits the user's environment so the
official CLI can use its own documented authentication and API-key modes.

## Requirements

- OpenCode with the external plugin API;
- Bun (the OpenCode plugin runtime);
- Google's official Antigravity CLI `agy` 1.1.8 or newer, on `PATH` or in a
  documented install location;
- an `agy` session authenticated independently of OpenCode.

The implementation was exercised against the installed `agy` 1.1.20. The
provider records the observed CLI version in `/health` and session metadata.

## Install the official CLI and authenticate

Install only from Google's documented installer:

```sh
# macOS/Linux
curl -fsSL https://antigravity.google/cli/install.sh | bash

# then authenticate in the project once
agy
```

On Windows, use Google's documented PowerShell or CMD installer. Do not put a
Google OAuth token in OpenCode configuration. `agy` itself owns keyring/session
storage and headless requests use the CLI's cached authentication.

## Install the plugin

From this checkout:

```sh
bun install
bun run build
```

Register the built package in `~/.config/opencode/opencode.json` (or the
project config):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/opencode-agy"]
}
```

Restart OpenCode after changing plugin configuration. Select the
`antigravity-cli` provider and one of the discovered models.

There is no OpenCode-owned OAuth flow. The API auth action, when shown by a
host, only records the fixed local marker `opencode-agy-local`; it does not
represent a Google credential. If authentication fails, run `agy` interactively
in the target project and complete the official sign-in, then retry.

An explicit “Install the official agy CLI” action is also available through the
provider auth surface. It runs only Google's fixed installer commands and is
never invoked during normal provider loading.

## Configuration

All optional settings are explicit environment/configuration choices:

| Variable | Purpose |
| --- | --- |
| `OPENCODE_AGY_PATH` | Explicit path to the official executable |
| `OPENCODE_AGY_PROXY_PORT` | Pin the loopback port; default is ephemeral |
| `OPENCODE_AGY_DEBUG=1` | Enable metadata-only debug logs |
| `OPENCODE_AGY_MODE=accept-edits\|plan` | Select a documented CLI mode |
| `OPENCODE_AGY_SANDBOX=1` | Pass the documented `--sandbox` flag |
| `OPENCODE_AGY_DANGEROUSLY_SKIP_PERMISSIONS=1` | Explicitly pass the dangerous CLI flag |
| `OPENCODE_AGY_AGENT` | Select a documented `agy` agent |
| `OPENCODE_AGY_HISTORY_MAX_CHARS` | Bound fallback host-history transfer |
| `OPENCODE_AGY_MAX_REQUEST_BYTES` | Bound JSON request bodies |
| `OPENCODE_AGY_REQUEST_READ_TIMEOUT_MS` | Bound slow request-body uploads |
| `OPENCODE_AGY_UTILITY_MAX_CHARS` | Bound title/summary one-shot argv input |
| `OPENCODE_AGY_TURN_STALL_MS` | Per-turn no-output watchdog |
| `OPENCODE_AGY_PRINT_TIMEOUT_MS` | CLI print timeout |
| `OPENCODE_AGY_IDLE_WORKER_MS` | Idle worker cleanup interval |
| `OPENCODE_AGY_MAX_SESSIONS` | Maximum in-memory session workers |
| `OPENCODE_AGY_TOOL_BRIDGE=1` | Experimental host-tool bridge; disabled by default |
| `OPENCODE_AGY_BRIDGE_CALL_TIMEOUT_MS` | Timeout for an experimental bridged tool call |
| `OPENCODE_AGY_DATA_DIR` | Override non-secret session metadata directory |

The default proxy bind address is `127.0.0.1` and its port is ephemeral. The
proxy requires the fixed non-secret local marker (`Bearer opencode-agy-local`)
for model requests; this is not a Google API key and does not grant access to
the CLI outside the loopback adapter.

### Official quota usage

The plugin also exposes `GET /v1/usage` (with the same local marker). It runs
the documented `agy -p /usage --output-format json` command and returns the
CLI's real five-hour and weekly remaining windows for Gemini and Claude/GPT
model groups. It does not invent prices or read credentials.

OpenChamber's Usage panel does not currently discover arbitrary OpenCode
plugin endpoints. Its Command Code card comes from an OpenChamber-side,
hard-coded `command-code` quota provider that calls Command Code's billing API.
Showing Antigravity in that panel requires adding an OpenChamber quota adapter
for `antigravity-cli`; installing this OpenCode plugin alone cannot modify that
registry.

## MVP boundaries

The MVP intentionally rejects image, PDF, audio, video, arbitrary content
parts, host tool callbacks, and OpenCode tool-call continuation. OpenCode may
still include tool definitions in a request; the adapter ignores those
definitions and never executes or forwards them as callbacks. Antigravity's own
built-in tools, permissions, MCP configuration, and subagents remain owned by
`agy`. Tool and subagent events are surfaced as compact reasoning telemetry;
they are never presented as tools executed by OpenCode.

### Attachment evaluation

The documented headless `stream-json` input accepts strings and text blocks;
the CLI's image/video clipboard support is interactive and does not define a
portable headless binary/file block. Local attachment materialization is
therefore deliberately deferred. The adapter rejects media, never copies a
file into the project, and never forwards or fetches remote URLs.

Titles/summaries and an OpenCode-to-MCP tool bridge are not enabled by default.
The repository contains an experimental, loopback-only bridge design, but it
is intentionally not enabled: the observed `agy` 1.1.20 build manages MCP
servers through its user-level registry and does not honor a fresh temporary
workspace config reliably. The plugin will never call `agy mcp add` or mutate
that global registry. The bridge is a separate security/lifecycle project and
should not be enabled until the CLI provides a reliable documented workspace
configuration path. It should not be added by
pretending that OpenCode's `tools` array is executable inside this adapter.

## Tests

```sh
bun run check

# Requires the locally installed and authenticated official CLI; consumes quota.
bun run test:live
```

The ordinary test suite uses a deterministic fake CLI and does not contact
Google. Live tests are opt-in.

## Terms and deployment note

This adapter technically uses the documented `agy` CLI scripting interface.
That is not a contractual guarantee that a third-party host is permitted by
current Google Antigravity terms or immune from account action. Review the
current CLI documentation and terms yourself. For enterprise or production
workloads, prefer documented Gemini API or Vertex/ADC credentials and an
officially supported integration.
