/**
 * Typed access to the plugin's preference branch.
 *
 * Every key is stored under `extensions.zotero.<addonRef>.<key>`; the scaffold
 * rewrites `addon/prefs.js` to that prefix at build time, so callers use the
 * bare key here.
 */

export type OutputMode = "same-dir" | "custom" | "storage";
export type BilingualLayout = "left-right" | "top-bottom";

export interface ProviderProfile {
  /** Stable id used by `activeProviderId`. */
  id: string;
  /** Preset id this profile was created from, or "custom". */
  preset: string;
  label: string;
  baseURL: string;
  apiKey: string;
  model: string;
  /** Optional per-provider overrides. */
  temperature?: number;
  concurrency?: number;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  /** Some endpoints reject `response_format`; disable it per provider. */
  jsonMode?: boolean;
  maxTokens?: number;
}

const KEY = (name: string) => `${prefsPrefix}.${name}`;

/**
 * Read a preference with the declared default from `addon/prefs.js`.
 *
 * @param name - bare preference key, e.g. `fontSizePt`.
 * @returns the stored value, or the default when unset.
 */
export function getPref<T>(name: string): T {
  return Zotero.Prefs.get(KEY(name), true) as T;
}

/**
 * Write a preference.
 *
 * @param name - bare preference key.
 * @param value - value to store; booleans and numbers keep their type.
 */
export function setPref(name: string, value: unknown): void {
  Zotero.Prefs.set(KEY(name), value as never, true);
}

/**
 * Read the provider profile list.
 *
 * A malformed stored value must not break the plugin, so parsing failures fall
 * back to an empty list and are reported through the log.
 *
 * @returns every profile the user has configured, in display order.
 */
export function getProviders(): ProviderProfile[] {
  const raw = getPref<string>("providers");
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ProviderProfile[]) : [];
  } catch (error) {
    ztoolkit.log("providers pref is not valid JSON, ignoring it", error);
    return [];
  }
}

/**
 * Persist the provider profile list.
 *
 * @param profiles - complete list to store, replacing the previous one.
 */
export function setProviders(profiles: ProviderProfile[]): void {
  setPref("providers", JSON.stringify(profiles));
}
