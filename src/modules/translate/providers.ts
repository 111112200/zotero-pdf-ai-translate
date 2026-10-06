/**
 * Built-in service presets.
 *
 * Every preset speaks the OpenAI `/chat/completions` protocol, because that is
 * the one interface essentially every vendor now exposes. A preset only fills in
 * defaults; the user can override every field, so an unlisted vendor still works
 * by picking "custom".
 */

import type { ProviderProfile } from "../../utils/prefs";

export interface ProviderPreset {
  id: string;
  label: string;
  baseURL: string;
  defaultModel: string;
  models?: string[];
  /** Whether the endpoint reliably accepts `response_format: json_object`. */
  jsonMode: boolean;
  /** Header carrying the credential; defaults to `Authorization: Bearer`. */
  authHeader?: string;
  /** Appended to the URL, e.g. Azure's `?api-version=`. */
  query?: string;
  note?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    jsonMode: true,
    note: "Good Chinese output and low price; supports context caching.",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"],
    jsonMode: true,
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    baseURL: "https://api.siliconflow.cn/v1",
    defaultModel: "Qwen/Qwen2.5-7B-Instruct",
    jsonMode: true,
    note: "Has a free tier; keep concurrency low on it.",
  },
  {
    id: "zhipu",
    label: "Zhipu GLM",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-flash",
    models: ["glm-4-flash", "glm-4-air", "glm-4-plus"],
    jsonMode: true,
  },
  {
    id: "moonshot",
    label: "Moonshot Kimi",
    baseURL: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-8k",
    jsonMode: true,
  },
  {
    id: "dashscope",
    label: "Alibaba DashScope",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    jsonMode: true,
  },
  {
    id: "ark",
    label: "Volcengine Ark",
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: "doubao-pro-32k",
    jsonMode: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    jsonMode: true,
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    baseURL: "http://localhost:11434/v1",
    defaultModel: "qwen2.5:7b",
    jsonMode: false,
    note: "Runs on your machine; the API key can be left empty.",
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    baseURL: "http://localhost:1234/v1",
    defaultModel: "local-model",
    jsonMode: false,
    note: "Runs on your machine; the API key can be left empty.",
  },
  {
    id: "custom",
    label: "Custom (OpenAI compatible)",
    baseURL: "",
    defaultModel: "",
    jsonMode: false,
    note: "Any endpoint exposing POST {baseURL}/chat/completions.",
  },
];

/**
 * Look up a preset by id.
 *
 * @param id - preset id, e.g. `deepseek`.
 * @returns the preset, or the custom preset when the id is unknown.
 */
export function findPreset(id: string): ProviderPreset {
  return (
    PROVIDER_PRESETS.find((preset) => preset.id === id) ??
    PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]
  );
}

/**
 * Build a ready-to-use profile from a preset.
 *
 * @param presetId - preset to instantiate.
 * @returns a profile with empty credentials, to be completed by the user.
 */
export function profileFromPreset(presetId: string): ProviderProfile {
  const preset = findPreset(presetId);
  return {
    id: presetId === "custom" ? `custom-${Date.now()}` : presetId,
    preset: presetId,
    label: preset.label,
    baseURL: preset.baseURL,
    apiKey: "",
    model: preset.defaultModel,
    jsonMode: preset.jsonMode,
  };
}

/**
 * Join a base URL with an endpoint path without doubling slashes.
 *
 * LLM base URLs are the single most common source of 404s, so the join is
 * defensive: trailing slashes are dropped and a `/v1` already present at the
 * end of the base is not repeated.
 *
 * @param baseURL - user-supplied base, with or without a trailing slash.
 * @param path - endpoint path such as `/chat/completions`.
 * @returns the absolute request URL.
 */
export function joinURL(baseURL: string, path: string): string {
  const base = baseURL.trim().replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  if (base.endsWith("/v1") && suffix.startsWith("/v1/")) {
    return base + suffix.slice(3);
  }
  return base + suffix;
}
