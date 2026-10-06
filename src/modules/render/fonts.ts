/**
 * Font loading for the translated column.
 *
 * The bundled font is a static GB2312 subset of Noto Sans SC (OFL-1.1,
 * 8 080 glyphs, ~2.3 MB), built by `tools/build-font-subset.py`. It covers
 * Simplified Chinese, Latin, Greek, CJK punctuation, kana, spacing accents,
 * combining diacritics and selected mathematical operator blocks.
 *
 * Users can override it with any TTF/OTF they prefer, which matters for
 * Traditional Chinese, Japanese and Korean output.
 */

import { getPref } from "../../utils/prefs";
import { fontHasGlyph, pdfLibFontkit } from "./fontkit";

const BUNDLED = "content/fonts/NotoSansSC-Regular.subset.ttf";

let cached: Uint8Array | undefined;
let cachedFrom = "";

/**
 * Read a file that ships inside the plugin.
 *
 * The plugin root can be `file://` (development install) or `resource://` /
 * `jar:` (packaged XPI), so three loaders are tried in order. Only the first
 * that yields bytes wins; failures are logged rather than thrown because the
 * caller has fallbacks.
 *
 * @param relative - path relative to the plugin root, e.g. `content/x.ttf`.
 * @returns the file contents, or `undefined` when nothing could read it.
 */
async function readPluginFile(relative: string): Promise<Uint8Array | undefined> {
  const url = `${rootURI}${relative}`;

  try {
    const response = await fetch(url);
    if (response.ok) {
      return new Uint8Array(await response.arrayBuffer());
    }
  } catch (error) {
    ztoolkit.log(`fetch failed for ${url}`, error);
  }

  try {
    const binary = await Zotero.File.getBinaryContentsAsync(url);
    if (binary) {
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i) & 0xff;
      }
      return bytes;
    }
  } catch (error) {
    ztoolkit.log(`Zotero.File read failed for ${url}`, error);
  }

  try {
    const response = await Zotero.HTTP.request("GET", url, {
      responseType: "arraybuffer",
      successCodes: false,
      errorDelayMax: 0,
    });
    const buffer = response.response as ArrayBuffer | undefined;
    if (buffer && buffer.byteLength) {
      return new Uint8Array(buffer);
    }
  } catch (error) {
    ztoolkit.log(`HTTP read failed for ${url}`, error);
  }

  return undefined;
}

/**
 * Read an arbitrary absolute font path chosen by the user.
 *
 * @param path - absolute filesystem path to a TTF/OTF/TTC.
 * @returns the file contents, or `undefined` when unreadable.
 */
async function readUserFont(path: string): Promise<Uint8Array | undefined> {
  try {
    if (!(await IOUtils.exists(path))) {
      return undefined;
    }
    return new Uint8Array(await IOUtils.read(path));
  } catch (error) {
    ztoolkit.log(`could not read the font at ${path}`, error);
    return undefined;
  }
}

/**
 * Load the font used for translated text.
 *
 * Preference order: the path the user configured, then the bundled subset. The
 * result is memoized because parsing a 2.3 MB font on every export would be
 * wasteful.
 *
 * @returns font bytes, or `undefined` when neither source is available.
 */
export async function loadTranslationFont(): Promise<Uint8Array | undefined> {
  const userPath = (getPref<string>("cjkFontPath") ?? "").trim();
  const source = userPath || BUNDLED;
  if (cached && cachedFrom === source) {
    return cached;
  }
  const bytes = userPath ? await readUserFont(userPath) : undefined;
  const resolved = bytes ?? (await readPluginFile(BUNDLED));
  if (!resolved) {
    ztoolkit.log("no translation font is available");
    return undefined;
  }
  cached = resolved;
  cachedFrom = source;
  return resolved;
}

/**
 * Check whether the font can render every character of a string.
 *
 * Missing glyphs would otherwise show up as blanks in the exported PDF, which
 * is far worse than a warning, so the caller reports them.
 *
 * @param fontBytes - font file contents.
 * @param text - text that will be drawn.
 * @returns the distinct characters the font cannot render.
 */
export function findMissingGlyphs(fontBytes: Uint8Array, text: string): string[] {
  const font = pdfLibFontkit.create(fontBytes);
  const missing = new Set<string>();
  for (const ch of text) {
    if (/\s/.test(ch)) {
      continue;
    }
    const cp = ch.codePointAt(0) ?? 0;
    if (!fontHasGlyph(font, cp)) {
      missing.add(ch);
    }
  }
  return [...missing];
}

/** Drop the memoized font, e.g. after the user changes the font path. */
export function invalidateFontCache(): void {
  cached = undefined;
  cachedFrom = "";
}
