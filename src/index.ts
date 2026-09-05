import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import {
  DIRECTORY_HEADER,
  EFFORT_HEADER,
  LOCAL_API_KEY,
  MODEL_HEADER,
  MESSAGE_HEADER,
  REQUEST_KIND_HEADER,
  ANTHROPIC_NPM,
  PROVIDER_ID,
  PROVIDER_NAME,
  SESSION_HEADER,
} from "./constants.js";
import { detectAcpServer } from "./acp-detect.js";
import { warn } from "./log.js";
import {
  acpModelCatalog,
  fallbackAcpModelCatalog,
  type AcpModel,
  type AcpModelCatalog,
} from "./models.js";
import { getProxyBaseUrl, startProxy, stopProxy } from "./proxy.js";
import { researchedMetadataFor } from "./model-metadata.js";

function zeroCost() {
  return { input: 0, output: 0, cache: { read: 0, write: 0 } };
}

function modelVariants(model: AcpModel): Record<string, Record<string, unknown>> {
  if (!model.variants) return {};
  const variants = Object.fromEntries(
    Object.entries(model.variants).map(([effort, value]) => [effort, { effort: value.effort }]),
  );
  // OpenCode's Anthropic transform adds a generic `max` variant to every
  // reasoning model. Antigravity ACP only accepts low, medium, and high, so
  // mark that generated variant as disabled before it reaches the UI.
  return { ...variants, max: { disabled: true } };
}

function providerModel(model: AcpModel, baseURL: string): Record<string, unknown> {
  const variants = modelVariants(model);
  const metadata = researchedMetadataFor(model);
  return {
    id: model.id,
    providerID: PROVIDER_ID,
    api: { id: model.id, url: baseURL, npm: ANTHROPIC_NPM },
    name: model.name,
    family: model.family,
    capabilities: {
      temperature: false,
      reasoning: Object.keys(variants).length > 0,
      attachment: true,
      toolcall: false,
      input: { text: true, audio: true, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: true,
    },
    modalities: { input: ["text", "image", "audio"], output: ["text"] },
    cost: zeroCost(),
    ...(metadata ? { limit: { context: metadata.context, output: metadata.output } } : {}),
    status: "active",
    options: { includeUsage: true },
    headers: {},
    release_date: "",
    variants,
  };
}

function configModel(model: AcpModel): Record<string, unknown> {
  const variants = modelVariants(model);
  const metadata = researchedMetadataFor(model);
  return {
    name: model.name,
    reasoning: Object.keys(variants).length > 0,
    interleaved: true,
    temperature: false,
    tool_call: false,
    attachment: true,
    modalities: { input: ["text", "image", "audio"], output: ["text"] },
    capabilities: { tools: false, input: ["text", "image", "audio"], output: ["text"] },
    ...(metadata ? { limit: { context: metadata.context, output: metadata.output } } : {}),
    options: { includeUsage: true },
    variants,
  };
}

export function buildProviderModels(catalog: AcpModelCatalog, baseURL: string): Record<string, Record<string, unknown>> {
  return Object.fromEntries(catalog.models.map((model) => [model.id, providerModel(model, baseURL)]));
}

function ensureProviderConfig(config: Record<string, any>, catalog: AcpModelCatalog): void {
  if (!config.provider || typeof config.provider !== "object") config.provider = {};
  const existing = config.provider[PROVIDER_ID] && typeof config.provider[PROVIDER_ID] === "object"
    ? config.provider[PROVIDER_ID]
    : {};
  const existingOptions = existing.options && typeof existing.options === "object" ? existing.options : {};
  const existingModels = existing.models && typeof existing.models === "object" ? existing.models : {};
  const baseURL = getProxyBaseUrl();
  const generatedModels = Object.fromEntries(catalog.models.map((model) => [model.id, configModel(model)]));
  config.provider[PROVIDER_ID] = {
    ...existing,
    name: typeof existing.name === "string" && existing.name.trim() ? existing.name : PROVIDER_NAME,
    npm: ANTHROPIC_NPM,
    options: {
      ...existingOptions,
      // The only key sent to the local adapter is a fixed non-secret marker.
      apiKey: LOCAL_API_KEY,
      baseURL,
      includeUsage: true,
    },
    models: { ...generatedModels, ...existingModels },
  };
}

async function currentCatalog(directory: string): Promise<AcpModelCatalog> {
  try {
    const detection = await detectAcpServer();
    return acpModelCatalog(detection.executable, null);
  } catch {
    return fallbackAcpModelCatalog();
  }
}

async function ensureLocalProviderMarker(client: unknown, directory: string): Promise<void> {
  const auth = client && typeof client === "object" ? (client as { auth?: unknown }).auth : undefined;
  const set = auth && typeof auth === "object" ? (auth as { set?: unknown }).set : undefined;
  if (typeof set !== "function") return;
  try {
    // This is deliberately the fixed local marker, never a Google credential.
    await (set as (this: unknown, options: unknown) => Promise<unknown>).call(auth, {
      path: { id: PROVIDER_ID },
      query: { directory },
      body: { type: "api", key: LOCAL_API_KEY },
    });
  } catch (error) {
    warn("could not persist the non-secret Antigravity ACP local provider marker", { kind: error instanceof Error ? error.name : "unknown" });
  }
}

/**
 * OpenCode plugin entrypoint. Authentication remains inside the official
 * Antigravity ACP server. The worker may reuse the official CLI's local OAuth
 * cache so users do not need to sign in twice.
 */
export const AntigravityCliPlugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  try {
    await startProxy(input.directory);
  } catch (error) {
    warn("could not start the Antigravity ACP proxy during plugin initialization", { kind: error instanceof Error ? error.name : "unknown" });
  }

  return {
    async config(config) {
      await startProxy(input.directory);
      await ensureLocalProviderMarker(input.client, input.directory);
      ensureProviderConfig(config as Record<string, any>, await currentCatalog(input.directory));
    },

    "chat.headers": async (hookInput, output) => {
      if (hookInput.model.providerID !== PROVIDER_ID) return;
      const messageModel = hookInput.message.model as unknown as { variant?: unknown } | undefined;
      const messageVariant = (hookInput.message as { variant?: unknown }).variant;
      const variant = typeof messageVariant === "string" && messageVariant ? messageVariant
        : typeof messageModel?.variant === "string" ? messageModel.variant : undefined;
      output.headers[MODEL_HEADER] = hookInput.model.id;
      if (variant) output.headers[EFFORT_HEADER] = variant;
      output.headers[DIRECTORY_HEADER] = input.directory;
      output.headers[SESSION_HEADER] = hookInput.sessionID;
      output.headers[MESSAGE_HEADER] = hookInput.message.id;
      output.headers[REQUEST_KIND_HEADER] = hookInput.agent === "title" ? "title"
        : ["summary", "compaction"].includes(hookInput.agent) ? "summary" : "chat";
    },

    "chat.params": async (hookInput, output) => {
      if (hookInput.model.providerID !== PROVIDER_ID) return;
      // ACP owns reasoning configuration. Do not let the provider adapter invent
      // a temperature or provider-native reasoning parameter.
      delete output.options.reasoningEffort;
      delete output.options.temperature;
    },

    provider: {
      id: PROVIDER_ID,
      async models() {
        await startProxy(input.directory);
        const catalog = await currentCatalog(input.directory);
        return buildProviderModels(catalog, getProxyBaseUrl()) as any;
      },
    },

    // This is deliberately an API method, not an OAuth method. It stores only
    // the fixed local marker and tells the user to authenticate the official
    // ACP server out of band.
    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "api",
          label: "Use the authenticated Antigravity ACP server",
          prompts: [{
            type: "select",
            key: "method",
            message: "Antigravity ACP authentication method",
            options: [
              { label: "Google account", value: "oauth-personal", hint: "Personal Google account" },
              { label: "Gemini Enterprise", value: "oauth-business", hint: "Enterprise Google login" },
              { label: "Gemini API key", value: "gemini-api-key", hint: "Uses the official ACP server's API-key flow" },
              { label: "Agent Platform", value: "agent-platform", hint: "Uses ADC or an Agent Platform key" },
            ],
          }],
          async authorize(inputs = {}) {
            const detection = await detectAcpServer();
            const method = typeof inputs.method === "string" && inputs.method.trim() ? inputs.method.trim() : "oauth-personal";
            const { createAcpWorker } = await import("./acp-process.js");
            const worker = await createAcpWorker({
              cwd: input.directory,
              executable: detection.executable,
              executableArgs: detection.args,
              authMethod: method,
              skipSession: true,
            });
            await worker.stop(true);
            return {
              type: "success" as const,
              key: LOCAL_API_KEY,
              provider: PROVIDER_ID,
              metadata: {
                instructions: `Authenticated the official ACP server using ${method}.`,
              },
            };
          },
        },
      ],
    },

    async dispose() {
      await stopProxy(input.directory);
    },
  };
};

export { acpModelCatalog, fallbackAcpModelCatalog } from "./models.js";
export { detectAcpServer } from "./acp-detect.js";
export {
  getProxyBaseUrl,
  getProxyPort,
  getProxyRuntime,
  refreshModels,
  startProxy,
  stopProxy,
} from "./proxy.js";
export { sessionPool } from "./session-pool.js";

export default AntigravityCliPlugin;
