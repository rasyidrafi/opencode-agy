import { describe, expect, test } from "bun:test";
import { fallbackAgyModelCatalog, parseModelOutput, resolveAgyModelSelection } from "../src/models.js";
import { buildProviderModels } from "../src/index.js";
import { researchedMetadataFor } from "../src/model-metadata.js";

describe("agy model discovery", () => {
  test("parses current tabular output", () => {
    expect(parseModelOutput("Fetching available models...\ngemini-x-high\tGemini X (High)\n")).toEqual([["gemini-x-high", "Gemini X (High)"]]);
  });

  test("parses documented JSON output", () => {
    expect(parseModelOutput(JSON.stringify({ models: [{ id: "model-a", name: "Model A" }] }))).toEqual([["model-a", "Model A"]]);
  });

  test("maps effort variants to exact CLI slugs", () => {
    const catalog = fallbackAgyModelCatalog("fake");
    const selected = resolveAgyModelSelection("gemini-3.7-flash", "low", catalog);
    expect(selected.cliModel).toBe("gemini-3.7-flash-low");
    expect(resolveAgyModelSelection("gemini-3.7-flash-high", "low", catalog).cliModel).toBe("gemini-3.7-flash-low");
  });

  test("exposes one named family instead of duplicate effort-suffixed rows", () => {
    const catalog = fallbackAgyModelCatalog("fake");
    const ids = catalog.models.map((model) => model.id);
    expect(ids).toContain("gemini-3.7-flash");
    expect(ids).not.toContain("gemini-3.7-flash-high");
    expect(catalog.models.find((model) => model.id === "gemini-3.7-flash")?.name).toBe("Gemini 3.7 Flash");
  });

  test("uses researched model limits only when a canonical match exists", () => {
    const catalog = fallbackAgyModelCatalog("fake");
    const models = buildProviderModels(catalog, "http://127.0.0.1:1/v1");
    expect(models["gemini-3.7-flash"].limit).toEqual({ context: 1_048_576, output: 65_536 });
    expect(researchedMetadataFor({ id: "gpt-oss-120b-medium", name: "GPT-OSS", cliModel: "gpt-oss-120b-medium", family: "gpt-oss-120b", effort: "medium" })?.output).toBe(32_768);
  });
});
