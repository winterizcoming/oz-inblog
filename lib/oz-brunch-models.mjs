import { execFileSync } from "node:child_process";

const MAX_EXPOSED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
export const BRUNCH_DEFAULT_MODEL_PRESET = "luna-medium";
const PRESET_DEFINITIONS = Object.freeze({
  "luna-low": { model: "gpt-5.6-luna", reasoningEffort: "low" },
  "luna-medium": { model: "gpt-5.6-luna", reasoningEffort: "medium" },
  "luna-high": { model: "gpt-5.6-luna", reasoningEffort: "high" },
  "luna-xhigh": { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
  "luna-max": { model: "gpt-5.6-luna", reasoningEffort: "max" },
  "terra-low": { model: "gpt-5.6-terra", reasoningEffort: "low" },
  "terra-medium": { model: "gpt-5.6-terra", reasoningEffort: "medium" },
  "terra-high": { model: "gpt-5.6-terra", reasoningEffort: "high" },
  "terra-xhigh": { model: "gpt-5.6-terra", reasoningEffort: "xhigh" },
  "terra-max": { model: "gpt-5.6-terra", reasoningEffort: "max" },
  "sol-low": { model: "gpt-5.6-sol", reasoningEffort: "low" },
  "sol-medium": { model: "gpt-5.6-sol", reasoningEffort: "medium" },
  "sol-high": { model: "gpt-5.6-sol", reasoningEffort: "high" },
  "sol-xhigh": { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
  "sol-max": { model: "gpt-5.6-sol", reasoningEffort: "max" }
});
export const BRUNCH_DEFAULT_MODEL_POLICY = Object.freeze({
  preset: BRUNCH_DEFAULT_MODEL_PRESET,
  ...PRESET_DEFINITIONS[BRUNCH_DEFAULT_MODEL_PRESET]
});

let cachedCatalog;

function parseCatalog(raw) {
  const parsed = JSON.parse(String(raw));
  const models = Array.isArray(parsed?.models) ? parsed.models : [];
  return new Map(models
    .filter((model) => model?.supported_in_api === true && model?.visibility === "list" && typeof model.slug === "string")
    .map((model) => [model.slug, new Set((model.supported_reasoning_levels ?? []).map((entry) => entry?.effort).filter((effort) => MAX_EXPOSED_EFFORTS.has(effort)))]));
}

export function readCodexModelCatalog({ execFile = execFileSync } = {}) {
  if (cachedCatalog) return new Map([...cachedCatalog].map(([key, values]) => [key, new Set(values)]));
  try {
    const output = execFile("codex", ["debug", "models"], { encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    cachedCatalog = parseCatalog(output);
  } catch {
    cachedCatalog = new Map();
  }
  return new Map([...cachedCatalog].map(([key, values]) => [key, new Set(values)]));
}

export function resetCodexModelCatalogCache() {
  cachedCatalog = undefined;
}

export function getBrunchModelCapabilities({ catalog = readCodexModelCatalog() } = {}) {
  const models = Object.entries(PRESET_DEFINITIONS)
    .filter(([, preset]) => catalog.get(preset.model)?.has(preset.reasoningEffort))
    .map(([preset, definition]) => ({ preset, ...definition }));
  return {
    models,
    defaultPreset: models.some((entry) => entry.preset === BRUNCH_DEFAULT_MODEL_PRESET)
      ? BRUNCH_DEFAULT_MODEL_PRESET
      : models.find((entry) => entry.preset === BRUNCH_DEFAULT_MODEL_PRESET)?.preset ?? models[0]?.preset ?? null
  };
}

export function resolveBrunchModelPreset(preset, { catalog = readCodexModelCatalog() } = {}) {
  const capabilities = getBrunchModelCapabilities({ catalog });
  const selected = capabilities.models.find((entry) => entry.preset === (preset ?? capabilities.defaultPreset));
  return selected ? { ...selected } : null;
}

export const BRUNCH_MODEL_PRESETS = PRESET_DEFINITIONS;
