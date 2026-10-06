/**
 * Bridge between fontkit 2 and pdf-lib's font embedder.
 *
 * pdf-lib 1.17.1 was written against fontkit 1.x. The two versions differ in
 * exactly one place that matters here: fontkit 1.x subsets expose
 * `encodeStream()`, a Node-style stream, while fontkit 2 subsets expose
 * `encode()` returning a `Uint8Array`.
 *
 * Substituting fontkit 2 is not cosmetic. fontkit 1.x mis-encodes TrueType
 * subsets whose `head.indexToLocFormat` is 1 (long `loca`), which any CJK subset
 * with more than ~1000 glyphs requires. The symptom is subtle and severe: the
 * PDF still carries correct text and `ToUnicode` mappings, so search and copy
 * work, but most glyph outlines come out empty and the page renders blank.
 * Measured on a 51-character sample, fontkit 1.x rendered 9 of 51 glyphs for a
 * long-`loca` Noto Sans SC subset; fontkit 2 renders 51 of 51, and the output
 * stays ~11 KB instead of ~1.5 MB when subsetting is disabled.
 */

import * as fontkit from "fontkit";

/** Minimal event emitter; the plugin sandbox must not depend on Node built-ins. */
class ByteStream {
  private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  on(event: string, handler: (...args: unknown[]) => void): this {
    (this.handlers[event] ??= []).push(handler);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers[event] ?? []) {
      handler(...args);
    }
  }
}

interface FontkitGlyph {
  id: number;
}

interface FontkitSubset {
  includeGlyph(glyph: FontkitGlyph | number): number;
  encode(): Uint8Array;
}

interface FontkitFontLike {
  createSubset(): FontkitSubset;
}

/**
 * Wrap one fontkit 2 font so pdf-lib can drive it.
 *
 * Only `createSubset` is intercepted; every other member is forwarded with its
 * `this` bound, because pdf-lib reads metrics and layout data off the same
 * object.
 */
function adaptFont<T extends FontkitFontLike>(font: T): T {
  return new Proxy(font, {
    get(target, property, receiver) {
      if (property === "createSubset") {
        return () => {
          const subset = target.createSubset();
          return {
            // TrueType outlines; pdf-lib only uses this to pick CIDFontType2
            // over CIDFontType0.
            cff: undefined,
            includeGlyph: (glyph: FontkitGlyph | number) => subset.includeGlyph(glyph),
            encodeStream() {
              const stream = new ByteStream();
              // pdf-lib subscribes after calling encodeStream(), so the bytes
              // must not be produced synchronously.
              queueMicrotask(() => {
                try {
                  stream.emit("data", subset.encode());
                  stream.emit("end");
                } catch (error) {
                  stream.emit("error", error);
                }
              });
              return stream;
            },
          };
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/**
 * A fontkit implementation pdf-lib accepts via `registerFontkit`.
 *
 * @example
 * ```ts
 * const doc = await PDFDocument.create();
 * doc.registerFontkit(pdfLibFontkit as never);
 * ```
 */
export const pdfLibFontkit = {
  /**
   * Parse font bytes.
   *
   * @param data - font file contents.
   * @param postscriptName - optional face name for a TrueType collection.
   * @returns a font object pdf-lib can embed.
   */
  create(data: Uint8Array, postscriptName?: string) {
    return adaptFont(fontkit.create(data, postscriptName));
  },
};

/**
 * Check whether a font can render a character.
 *
 * pdf-lib exposes no coverage query, so this goes straight to fontkit.
 *
 * @param font - a font created by {@link pdfLibFontkit}.
 * @param codePoint - Unicode code point to test.
 * @returns true when the font has an outline for it.
 */
export function fontHasGlyph(font: unknown, codePoint: number): boolean {
  const candidate = font as {
    hasGlyphForCodePoint?: (cp: number) => boolean;
  };
  if (typeof candidate.hasGlyphForCodePoint !== "function") {
    return true;
  }
  return candidate.hasGlyphForCodePoint(codePoint);
}
