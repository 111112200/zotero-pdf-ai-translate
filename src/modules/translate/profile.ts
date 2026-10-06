/**
 * Resolve the AI service the user configured.
 *
 * Two storage shapes are supported: a list of named profiles (so several
 * services can be kept side by side) and the flat `baseURL` / `apiKey` / `model`
 * preferences written by the settings pane. The flat form wins when it is filled
 * in, because that is what the settings pane edits directly.
 */

import { getPref, getProviders, type ProviderProfile } from "../../utils/prefs";
import { findPreset, profileFromPreset } from "./providers";

/**
 * Build the profile to use for a translation run.
 *
 * @returns a complete profile.
 * @throws when no endpoint or model has been configured, with a message that
 *   points at the settings pane.
 */
export function resolveActiveProfile(): ProviderProfile {
  const providers = getProviders();
  const activeId = getPref<string>("activeProviderId") || "";
  const stored =
    providers.find((entry) => entry.id === activeId) ?? providers[0];

  const base = stored ?? profileFromPreset(activeId || "deepseek");
  const profile: ProviderProfile = {
    ...base,
    baseURL: (getPref<string>("baseURL") || base.baseURL || "").trim(),
    apiKey: (getPref<string>("apiKey") || base.apiKey || "").trim(),
    model: (getPref<string>("model") || base.model || "").trim(),
    temperature: getPref<number>("temperature") ?? base.temperature ?? 0.2,
    concurrency: getPref<number>("concurrency") ?? base.concurrency ?? 4,
  };

  if (!profile.baseURL) {
    const preset = findPreset(profile.preset);
    profile.baseURL = preset.baseURL;
  }
  if (!profile.baseURL) {
    throw new Error(
      "No AI service is configured. Open Tools → PDF AI Translate Settings and fill in the base URL and API key.",
    );
  }
  if (!profile.model) {
    throw new Error(
      "No model is configured. Open Tools → PDF AI Translate Settings and enter a model name.",
    );
  }
  return profile;
}
