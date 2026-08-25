import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import {
  AGENT_HEADER,
  DIRECTORY_HEADER,
  EFFORT_HEADER,
  LOCAL_API_KEY,
  MODEL_HEADER,
  OPENAI_COMPATIBLE_NPM,
  PROVIDER_ID,
  PROVIDER_NAME,
  SESSION_HEADER,
} from "./constants.js";
import { detectAgy, resetAgyDetectionCache } from "./cli-detect.js";
import { installOfficialAgy } from "./cli-install.js";
import { warn } from "./log.js";
import {
  discoverAgyModels,
  fallbackAgyModelCatalog,
  type AgyModel,
  type AgyModelCatalog,
} from "./models.js";
import { getProxyBaseUrl, startProxy, stopProxy } from "./proxy.js";
import { researchedMetadataFor } from "./model-metadata.js";

function zeroCost() {
  return { input: 0, output: 0, cache: { read: 0, write: 0 } };
}

function modelVariants(model: AgyModel): Record<string, Record<string, unknown>> {
  if (!model.variants) return {};
  return Object.fromEntries(
    Object.entries(model.variants).map(([effort, value]) => [effort, { effort: value.effort }]),
  );
}

function providerModel(model: AgyModel, baseURL: string): Record<string, unknown> {
  const variants = modelVariants(model);
  const metadata = researchedMetadataFor(model);
  return {
    id: model.id,
    providerID: PROVIDER_ID,
    api: { id: model.id, url: baseURL, npm: OPENAI_COMPATIBLE_NPM },
    name: model.name,
    family: model.family,
    capabilities: {
      temperature: false,
      reasoning: Object.keys(variants).length > 0,
      attachment: false,
      toolcall: false,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    modalities: { input: ["text"], output: ["text"] },
    cost: zeroCost(),
    ...(metadata ? { limit: { context: metadata.context, output: metadata.output } } : {}),
    status: "active",
    options: { includeUsage: true },
    headers: {},
    release_date: "",
    variants,
  };
}

function configModel(model: AgyModel): Record<string, unknown> {
  const variants = modelVariants(model);
  const metadata = researchedMetadataFor(model);
  return {
    name: model.name,
    reasoning: Object.keys(variants).length > 0,
    temperature: false,
    tool_call: false,
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
    capabilities: { tools: false, input: ["text"], output: ["text"] },
    ...(metadata ? { limit: { context: metadata.context, output: metadata.output } } : {}),
    options: { includeUsage: true },
    variants,
  };
}

export function buildProviderModels(catalog: AgyModelCatalog, baseURL: string): Record<string, Record<string, unknown>> {
  return Object.fromEntries(catalog.models.map((model) => [model.id, providerModel(model, baseURL)]));
}

function ensureProviderConfig(config: Record<string, any>, catalog: AgyModelCatalog): void {
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
    npm: existing.npm ?? OPENAI_COMPATIBLE_NPM,
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

async function currentCatalog(directory: string): Promise<AgyModelCatalog> {
  try {
    return await discoverAgyModels(false, directory);
  } catch {
    return fallbackAgyModelCatalog();
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
    warn("could not persist the non-secret agy local provider marker", { kind: error instanceof Error ? error.name : "unknown" });
  }
}

/**
 * OpenCode plugin entrypoint. Authentication remains entirely inside the
 * official `agy` process; this hook only publishes a local provider adapter.
 */
export const AntigravityCliPlugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  try {
    await startProxy(input.directory);
  } catch (error) {
    warn("could not start the agy proxy during plugin initialization", { kind: error instanceof Error ? error.name : "unknown" });
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
      const variant = typeof messageModel?.variant === "string" ? messageModel.variant : undefined;
      output.headers[MODEL_HEADER] = hookInput.model.id;
      if (variant) output.headers[EFFORT_HEADER] = variant;
      output.headers[DIRECTORY_HEADER] = input.directory;
      output.headers[SESSION_HEADER] = hookInput.sessionID;
      const options = hookInput.provider.options;
      const agent = typeof options.agyAgent === "string" ? options.agyAgent : undefined;
      if (agent) output.headers[AGENT_HEADER] = agent;
    },

    "chat.params": async (hookInput, output) => {
      if (hookInput.model.providerID !== PROVIDER_ID) return;
      // The CLI owns reasoning effort. Do not let an OpenAI adapter invent a
      // temperature or provider-native reasoning parameter.
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
    // the fixed local marker and tells the user to authenticate with agy.
    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "api",
          label: "Use the authenticated agy CLI",
          async authorize() {
            await detectAgy();
            return {
              type: "success" as const,
              key: LOCAL_API_KEY,
              provider: PROVIDER_ID,
              metadata: {
                instructions: "Run agy interactively once in the project to complete official Google sign-in.",
              },
            };
          },
        },
        {
          type: "api",
          label: "Install the official agy CLI",
          async authorize() {
            await installOfficialAgy();
            resetAgyDetectionCache();
            await detectAgy(true);
            return {
              type: "success" as const,
              key: LOCAL_API_KEY,
              provider: PROVIDER_ID,
              metadata: {
                instructions: "The official agy CLI was installed. Run agy once interactively to authenticate.",
              },
            };
          },
        },
      ],
    },

    async dispose() {
      await stopProxy();
    },
  };
};

export { discoverAgyModels, fallbackAgyModelCatalog } from "./models.js";
export { detectAgy } from "./cli-detect.js";
export {
  getProxyBaseUrl,
  getProxyPort,
  getProxyRuntime,
  refreshModels,
  startProxy,
  stopProxy,
} from "./proxy.js";
export { sessionPool } from "./session-pool.js";
export { getAgyUsage, resetAgyUsageCache } from "./agy-usage.js";

export default AntigravityCliPlugin;
