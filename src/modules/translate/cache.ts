/**
 * Translation cache.
 *
 * Re-running a translation after a crash, a settings change or a partial
 * failure must not re-pay for text that was already translated. Entries are
 * keyed by the source text together with everything that changes the answer:
 * model, base URL, target language and prompt.
 *
 * The store is a JSON file in the Zotero data directory because plugin
 * preferences are a poor fit for tens of thousands of entries.
 */

import type { ProviderProfile } from "../../utils/prefs";
import { getPref } from "../../utils/prefs";

const FILE_NAME = "pdf-ai-translate-cache.json";
/** Bump when the prompt changes enough to invalidate stored translations. */
const PROMPT_VERSION = 3;
/** Entries beyond this are dropped oldest-first when saving. */
const MAX_ENTRIES = 60_000;

/** FNV-1a in four variants, giving a 128-bit key without a crypto dependency. */
function hash128(input: string): string {
  const seeds = [0x811c9dc5, 0x01000193, 0x7fffffff, 0x9e3779b9];
  const parts: string[] = [];
  for (const seed of seeds) {
    let hash = seed >>> 0;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    parts.push(hash.toString(16).padStart(8, "0"));
  }
  return parts.join("");
}

interface CacheFile {
  version: number;
  entries: Record<string, string>;
}

/** Keyed store of translated segments. */
export class TranslationCache {
  private entries = new Map<string, string>();
  private dirty = false;
  private readonly namespace: string;
  private readonly enabled: boolean;

  constructor(profile: ProviderProfile, targetLang: string, promptExtra: string) {
    this.enabled = getPref<boolean>("cacheEnabled") !== false;
    this.namespace = hash128(
      [PROMPT_VERSION, profile.baseURL, profile.model, targetLang, promptExtra].join("\u0000"),
    );
  }

  private get path(): string {
    return PathUtils.join(Zotero.DataDirectory.dir, FILE_NAME);
  }

  /** Load the cache from disk. Failure is non-fatal: the cache is an optimization. */
  async load(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    try {
      if (!(await IOUtils.exists(this.path))) {
        return;
      }
      const parsed = JSON.parse(await IOUtils.readUTF8(this.path)) as CacheFile;
      if (parsed?.version !== PROMPT_VERSION) {
        return;
      }
      for (const [key, value] of Object.entries(parsed.entries ?? {})) {
        if (key.startsWith(this.namespace) && typeof value === "string") {
          this.entries.set(key, value);
        }
      }
    } catch (error) {
      ztoolkit.log("translation cache could not be read; starting empty", error);
    }
  }

  /**
   * Look up a previously translated segment.
   *
   * @param source - source text.
   * @returns the cached translation, or `undefined` on a miss.
   */
  get(source: string): string | undefined {
    if (!this.enabled) {
      return undefined;
    }
    return this.entries.get(this.keyFor(source));
  }

  /**
   * Store a translation.
   *
   * @param source - source text.
   * @param translated - translated text.
   */
  set(source: string, translated: string): void {
    if (!this.enabled) {
      return;
    }
    this.entries.set(this.keyFor(source), translated);
    this.dirty = true;
  }

  /** Persist the cache, trimming the oldest entries when it grows too large. */
  async save(): Promise<void> {
    if (!this.enabled || !this.dirty) {
      return;
    }
    try {
      let entries = Object.fromEntries(this.entries);
      const keys = Object.keys(entries);
      if (keys.length > MAX_ENTRIES) {
        entries = Object.fromEntries(
          keys.slice(keys.length - MAX_ENTRIES).map((key) => [key, entries[key]]),
        );
      }
      const payload: CacheFile = { version: PROMPT_VERSION, entries };
      await IOUtils.writeUTF8(this.path, JSON.stringify(payload));
      this.dirty = false;
    } catch (error) {
      ztoolkit.log("translation cache could not be written", error);
    }
  }

  /** Number of entries currently held. */
  get size(): number {
    return this.entries.size;
  }

  private keyFor(source: string): string {
    return `${this.namespace}:${hash128(source)}`;
  }
}
