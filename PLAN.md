# opencode-agy implementation plan

**Status:** Implemented MVP plus an opt-in MCP bridge design (runtime bridge use remains deferred)
**Date:** 2026-08-25

## 1. Objective

Build an OpenCode plugin that uses Google's official `agy` executable as the
Antigravity communication and execution layer.

The plugin must:

- communicate with Antigravity only through the documented `agy` CLI protocol;
- use the CLI's own authentication, keyring, session, and credential handling;
- never read, extract, refresh, copy, or persist Google OAuth credentials;
- never call Antigravity's private HTTP gateway directly;
- expose Antigravity sessions to OpenCode through a local OpenAI-compatible
  provider surface;
- provide streaming text, model selection, effort selection, session resume,
  usage, and honest error handling.

The initial product is an **external-agent adapter**: OpenCode provides the
host UI and session identity, while Antigravity owns the agent loop, built-in
tools, permissions, MCP, and subagents.

## 2. Explicit non-goals

- Do not implement an OAuth flow or inspect the system keyring.
- Do not reproduce the private Antigravity API protocol or its headers.
- Do not extract or store refresh/access tokens.
- Do not claim that a wrapper guarantees immunity from Google account action.
- Do not initially bridge OpenCode's dynamically supplied tools into `agy`.
- Do not silently drop OpenCode image, PDF, audio, or video parts.
- Do not make the official Python SDK a dependency of the first TypeScript
  implementation.

The official CLI documentation supports scripting and CI usage, but Google's
Antigravity terms also restrict third-party access. The README and sign-in
flow must state that using OpenCode as a host is technically based on the
documented CLI interface, not a contractual guarantee.

## 3. Official CLI contract to target

The implementation should target a tested minimum `agy` version and record the
observed version in diagnostics. The current official changelog documents the
following interface:

### One-shot mode

```bash
agy -p "prompt" --output-format json
agy -p "prompt" --output-format stream-json
```

The JSON envelope includes `conversation_id`, `status`, `response`, optional
`error`, duration, turn count, and token usage.

### Persistent streaming mode

```bash
agy --input-format stream-json --output-format stream-json
```

The process accepts one JSON object per input line. A user message is shaped
like:

```json
{"event":"user","message":{"content":"Do the task"}}
```

The content may be a string or text blocks. The documented input protocol does
not accept arbitrary media blocks or host control messages.

The output is NDJSON with:

- one `init` event containing the conversation ID, working directory, tools,
  and effective permission mode;
- `step_update` events containing text deltas, step state, tool metadata,
  subagent metadata, and usage where available;
- one `result` event per prompt containing the turn response, status, errors,
  conversation ID, and cumulative usage.

### Other supported flags and commands

- `--model`
- `--effort low|medium|high`
- `--agent`
- `--continue`
- `--conversation <id>`
- `--print-timeout`
- `--sandbox`
- `--dangerously-skip-permissions`
- `agy models --output-format json`
- `agy agents --output-format json`

`control_request` and `control_response` are documented as unsupported in
streaming input. A malformed or unsupported input message can terminate the
session. The process manager must treat this as a protocol failure, not as a
normal assistant response.

## 4. Target architecture

```text
OpenCode
  |
  | OpenAI-compatible provider request
  v
opencode-agy plugin
  |
  | local 127.0.0.1 proxy
  v
Session manager
  |
  | stdin: user NDJSON
  | stdout: response NDJSON
  v
official agy process
  |
  | official keyring / Google sign-in / configured API-key mode
  v
Antigravity agent harness
```

The proxy should bind to loopback only and use an ephemeral port by default.
The OpenCode provider receives the live base URL and a non-secret placeholder
API key, matching the local proxy pattern used by `opencode-claude`.

## 5. Proposed project layout

```text
opencode-agy/
├── PLAN.md
├── README.md
├── package.json
├── tsconfig.json
├── opencode-agy.js
├── src/
│   ├── index.ts                 # OpenCode plugin hooks and provider config
│   ├── constants.ts             # Provider ID, headers, limits, defaults
│   ├── cli-detect.ts            # agy discovery and version probing
│   ├── cli-install.ts           # Explicit, user-triggered official install
│   ├── cli-process.ts            # Child process lifecycle and I/O
│   ├── protocol.ts               # NDJSON encode/decode and event validation
│   ├── session-pool.ts           # One serialized worker per OpenCode session
│   ├── session-store.ts          # Non-secret conversation ID persistence
│   ├── models.ts                 # Dynamic agy model discovery and variants
│   ├── prompt.ts                 # Text-only OpenCode prompt normalization
│   ├── proxy.ts                  # /health, /models, /chat/completions
│   ├── translate.ts              # agy events to OpenAI response/SSE chunks
│   ├── request-kind.ts           # title/summary utility request detection
│   ├── utility.ts                # isolated one-shot utility requests
│   ├── agents.ts                 # documented agy agent discovery
│   ├── agy-usage.ts              # official /usage quota-window parsing
│   ├── errors.ts                 # Auth, quota, timeout, protocol errors
│   └── log.ts                    # Redacted, debug-gated logging
├── test/
│   ├── protocol.ts
│   ├── cli-process.ts
│   ├── session-pool.ts
│   ├── translate.ts
│   ├── proxy-smoke.ts
│   └── agy-live.ts               # Opt-in tests requiring installed agy/auth
└── fixtures/
    └── stream-json/
```

## 6. Implementation phases

### Phase 0: CLI compatibility spike

- [x] Verify the installed `agy` binary on Linux, macOS, and Windows.
- [x] Capture `agy --version` and `agy --help` output for supported versions.
- [x] Capture the exact JSON shape from `agy models --output-format json`.
- [x] Run an authenticated one-shot JSON request.
- [x] Run two prompts through one persistent `stream-json` process.
- [x] Verify the same `conversation_id` is returned for both turns.
- [x] Verify text deltas, final result, usage, tool events, and subagent events.
- [x] Verify unknown-model, unauthenticated, timeout, and malformed-input
  behavior.
- [x] Verify behavior when stdout is piped or connected to a subprocess.
- [x] Record version-specific differences as protocol fixtures.

Do not proceed to provider integration until the persistent subprocess protocol
works reliably outside a TTY.

### Phase 1: Package and OpenCode provider scaffold

- [x] Create the TypeScript/Bun package and build configuration.
- [x] Export a plugin from `opencode-agy.js`.
- [x] Register a provider ID such as `antigravity-cli` while using `agy` as the
  executable name.
- [x] Start the local proxy from the OpenCode config hook.
- [x] Publish the live loopback base URL into provider configuration.
- [x] Add `/health` and `/v1/models` endpoints.
- [x] Advertise text input and text output only.
- [x] Advertise `toolcall: false` for the MVP so OpenCode does not assume that
  its own tool-call continuation protocol is supported.

### Phase 2: Robust `agy` process manager

- [x] Resolve `agy` from PATH and documented install locations.
- [x] Never log the child environment or credential-related values.
- [x] Spawn with the OpenCode project directory as `cwd`.
- [x] Preserve the user's CLI authentication environment without inspecting it.
- [x] Use line-buffered stdin/stdout handling with backpressure.
- [x] Bound stderr and diagnostic buffers.
- [x] Parse one complete JSON event per line.
- [x] Ignore forward-compatible unknown output event types where safe.
- [x] Reject malformed events with a protocol error.
- [x] Detect process exit, broken pipes, EOF, and non-zero exit codes.
- [x] Add a per-turn stall watchdog and overall print timeout.
- [x] Kill the process tree on cancellation or client disconnect.
- [x] Prevent two writes or two active turns on the same worker.
- [x] Ensure shutdown closes stdin and waits before escalating to termination.

The worker state machine should be explicit:

```text
created -> starting -> ready -> turn_active -> ready -> closing -> closed
                                      \-> failed
```

### Phase 3: Session pool and persistence

- [x] Key workers by OpenCode session ID when available.
- [x] Fall back to a hashed request key only when no host session ID exists.
- [x] Serialize requests per session and reject or queue concurrent turns.
- [x] Store only conversation ID, model, effort, cwd, CLI version, and timestamps.
- [x] Store state under `$XDG_DATA_HOME/opencode-agy/` with restrictive file
  permissions.
- [x] Never store OAuth material.
- [x] Recreate a worker with `--conversation <id>` after a process restart.
- [x] Detect a missing or invalid conversation and fall back to a bounded text
  history transfer.
- [x] Avoid sending the same prompt twice after an ambiguous process failure.
- [x] Add idle worker cleanup and plugin shutdown cleanup.

Model or effort changes cannot be sent as arbitrary stream input. Treat a
change in `(model, effort, agent, cwd, permission mode)` as a worker restart,
then resume the saved conversation where supported.

### Phase 4: OpenAI-compatible proxy translation

- [x] Implement `POST /v1/chat/completions`.
- [x] Validate that a latest user message exists.
- [x] Reject unsupported media parts explicitly with a useful error.
- [x] Extract the latest text prompt instead of replaying the entire OpenCode
  message list into an already persistent `agy` conversation.
- [x] On the first turn, optionally include a bounded, clearly delimited copy of
  relevant OpenCode context that cannot be supplied as a system message.
- [x] Do not treat OpenCode's `tools` array as executable host callbacks in the
  MVP.
- [x] For streaming requests, send an initial assistant role chunk, forward
  `text_delta`, forward compact tool/subagent status as non-tool metadata or
  reasoning text, then send a final chunk and `[DONE]`.
- [x] For non-streaming requests, buffer the turn and return one completion.
- [x] Map `result.response` to assistant content.
- [x] Map input, output, thinking, cache-read, and total usage into OpenAI usage
  fields where available.
- [x] Report subscription usage without inventing a USD price.
- [x] Return truthful HTTP errors before committing a stream when possible.
- [x] Use retryable status and headers for detected quota/rate-limit failures.
- [x] Never turn a failed CLI run into a successful assistant message.

### Phase 5: Model discovery and variants

- [x] Invoke `agy models --output-format json` during provider model loading.
- [x] Cache the result for the lifetime of the plugin process.
- [x] Validate model names before passing them to `agy`.
- [x] Preserve exact CLI model slugs.
- [x] Normalize models with effort suffixes into OpenCode variants only when the
  CLI output makes the relationship unambiguous.
- [x] Map OpenCode `low`, `medium`, and `high` variants to `--effort`.
- [x] Do not advertise unsupported temperature, audio, video, image, or PDF
  capabilities.
- [x] Provide a static fallback catalog only for graceful startup when model
  discovery is temporarily unavailable.

### Phase 6: Authentication and installation UX

- [x] Detect whether `agy` is installed without reading credential files.
- [x] Make the primary instruction: run `agy` interactively once in the target
  project and complete official Google sign-in.
- [x] Confirm that headless requests use cached CLI credentials and fail fast if
  the CLI is unauthenticated.
- [x] Provide an explicit install action using only Google's official
  installer.
- [x] Never install automatically during normal provider loading.
- [x] Never implement an OpenCode-owned OAuth callback or token refresh.
- [x] Make account/API-key modes work by passing through documented CLI
  configuration and environment behavior.
- [x] Clearly explain that the plugin cannot verify account eligibility without
  making an agent request.

### Phase 7: Optional MCP/tool bridge

This phase is intentionally separate from the MVP.

- [x] Decide whether Antigravity-owned tools are sufficient for the MVP: they
  are sufficient, so the host-tool bridge remains disabled.
- [x] If OpenCode tools are required, design a per-session local MCP bridge.
- [x] Use the documented `.agents/mcp_config.json` or another documented
  configuration path rather than private CLI internals.
- [x] Expose stable bridge tools with correlation IDs and bounded arguments.
- [x] Route bridge calls through a loopback IPC endpoint owned by the plugin.
- [x] Return tool results, errors, cancellation, and timeouts to the MCP server.
- [x] Prevent bridge credentials or arbitrary local endpoints from being
  exposed to the model.
- [x] Avoid mutating a user's global MCP configuration.
- [x] Single bridged calls are correlated and serialized; parallel bridged
  calls are intentionally deferred until the single-call path is reliable in
  a CLI build that honors workspace MCP configuration.
- [x] Add explicit permission and audit logging for bridged operations.

If native tool control becomes a hard requirement, evaluate a separate Python
sidecar using Google's official `google-antigravity` SDK with Gemini API or
Vertex/ADC credentials. Do not assume that SDK shares the CLI's Google-account
keyring session.

### Phase 8: Attachments and utility requests

- [x] Keep the MVP text-only and reject unsupported OpenCode media explicitly.
- [x] Evaluate a safe file-materialization strategy for local attachments. The
  documented headless protocol accepts text only, so materialization is
  deferred and media is rejected explicitly; see `src/attachments.ts`.
- [x] Keep remote URLs out of prompts unless the user explicitly authorizes the
  CLI's URL-reading behavior.
- [x] Route title and summary requests through isolated one-shot workers so they
  do not contaminate the main conversation.
- [x] Ensure utility requests cannot use project tools unless intentionally
  configured.

The Phase 7 bridge remains deliberately deferred: Antigravity-owned tools are
sufficient for the MVP, and host-tool continuation would require a separate
security and protocol design.
The live `agy` probe confirmed that `agy mcp add` populates a user-level
registry; the implementation refuses to call that command and therefore does
not silently mutate global MCP state.

## 7. Security and compliance requirements

- [x] No imports or requests targeting Google's private Antigravity endpoints.
- [x] No OAuth client ID/secret, refresh-token parser, token store, or keyring
  reader in this project.
- [x] No fingerprint, fake client metadata, or private gateway headers.
- [x] Bind the proxy to `127.0.0.1` only.
- [x] A random request token is not needed because this implementation never
  binds beyond loopback.
- [x] Redact prompts, environment values, authorization headers, and tool
  arguments from logs by default.
- [x] Use restrictive permissions for session metadata and temporary files.
- [x] Document that headless workers always require dangerous-permissions mode
  because the stream protocol cannot service interactive approvals.
- [x] Document Google's current Antigravity terms and the remaining ambiguity
  around third-party hosts.
- [x] Recommend official Vertex/API credentials for enterprise or production
  workflows.

## 8. Testing strategy

### Unit tests

- [x] NDJSON encoding and decoding.
- [x] Unknown event compatibility.
- [x] Malformed event and oversized-line handling.
- [x] Process state transitions.
- [x] Backpressure and partial-line buffering.
- [x] Session-key stability and persistence.
- [x] Model/effort resolution.
- [x] Prompt extraction and media rejection.
- [x] OpenAI response and SSE translation.
- [x] Usage conversion.
- [x] Error classification and retry behavior.
- [x] Redaction tests proving tokens and sensitive environment values never log.

### Mocked integration tests

- [x] Successful non-streaming turn.
- [x] Successful streaming turn.
- [x] Two turns through one persistent worker.
- [x] Multiple sessions isolated from each other.
- [x] Worker restart and conversation resume.
- [x] Model/effort change causes controlled restart.
- [x] Client cancellation kills the worker.
- [x] CLI exits before output.
- [x] CLI emits an error after partial output.
- [x] Unknown model and authentication failures.
- [x] Tool and subagent telemetry is surfaced without fake OpenCode tool calls.

### Opt-in live tests

These require a locally installed and authenticated official `agy` binary and
must never run in ordinary CI:

- [x] `agy` discovery and version probe.
- [x] Dynamic model discovery.
- [x] Authenticated text response.
- [x] Persistent two-turn context retention.
- [x] Model and effort selection.
- [x] JSON and stream-JSON output.
- [x] Shell/file permission behavior in headless mode.
- [x] `--conversation` restart behavior.
- [x] Timeout and cancellation behavior.
- [x] OpenCode CLI smoke test through the plugin.

## 9. Acceptance criteria for the MVP

- [x] User installs and authenticates the official `agy` CLI independently.
- [x] User can run an OpenCode request against an Antigravity model without an
  OpenCode OAuth token prompt.
- [x] The plugin launches only the official `agy` executable for inference.
- [x] Streaming and non-streaming text requests both work.
- [x] A follow-up message retains the same Antigravity conversation context.
- [x] A plugin restart can resume a saved conversation where the CLI supports it.
- [x] Model and effort selection are visible and effective.
- [x] Usage and Antigravity tool activity are visible without pretending that
  OpenCode executed those tools.
- [x] Unsupported attachments and tool-call expectations fail explicitly.
- [x] Authentication, quota, timeout, and process failures are reported as
  failures rather than assistant text.
- [x] No credentials are read, copied, stored, or logged by the plugin.
- [x] No private Google endpoint is present in source or tests.

## 10. Open decisions before implementation

- [x] Final provider ID: `antigravity-cli`.
- [x] Minimum supported CLI version: `1.1.8`, based on the Phase 0 protocol spike.
- [x] Main user workers are persistent; utility requests use isolated one-shot
  workers.
- [x] Workers are persistent and cleaned up after the configured idle time;
  utility requests use one-shot mode.
- [x] Maximum transferred history size when resuming fails is bounded by
  `OPENCODE_AGY_HISTORY_MAX_CHARS` (default 100,000).
- [x] The MVP exposes Antigravity tool activity as reasoning text rather than
  a custom metadata extension, or only logs.
- [x] Title/summary generation uses isolated `agy` workers and therefore may
  consume Antigravity quota.
- [x] The optional MCP bridge is not enabled by default; Antigravity-owned tools
  are sufficient for the MVP and the observed CLI does not reliably honor a
  fresh workspace MCP config, so parallel/production bridge use remains deferred.
- [x] The README recommends Vertex/ADC or API credentials for enterprise
  deployment rather than the CLI account session.

## 11. Research sources

- [Antigravity CLI overview](https://antigravity.google/docs/cli/overview/)
- [Antigravity CLI headless mode](https://antigravity.google/docs/cli/headless/)
- [Installation and authentication](https://antigravity.google/docs/cli/install/)
- [CLI reference](https://antigravity.google/docs/cli/reference/)
- [CLI permissions](https://antigravity.google/docs/cli/permissions/)
- [CLI MCP support](https://antigravity.google/docs/cli/mcp/)
- [Google Antigravity CLI repository](https://github.com/google-antigravity/antigravity-cli)
- [Google Antigravity Python SDK](https://github.com/google-antigravity/antigravity-sdk-python)
- [Google Antigravity terms](https://antigravity.google/terms)
- [OpenCode Claude reference plugin](https://github.com/openchamber/opencode-claude)
