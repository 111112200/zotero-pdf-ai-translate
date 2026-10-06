/**
 * Local type declarations for things `zotero-types@4.1.3` does not describe.
 *
 * Two gaps matter here:
 *
 *  - `fontkit` ships no types of its own, and only its browser build is used.
 *  - `Zotero.SDT` and the Zotero 10 shapes are not in the published package
 *    (its default branch has them, but no release does). Nothing in this plugin
 *    depends on `Zotero.SDT`, so only the loose module declaration is needed.
 */

declare module "fontkit" {
  /** A parsed font, as far as this plugin uses one. */
  export interface FontkitFont {
    postscriptName: string;
    unitsPerEm: number;
    ascent: number;
    descent: number;
    lineGap: number;
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
    characterSet: number[];
    numGlyphs: number;
    layout: (
      text: string,
      features?: unknown,
    ) => { glyphs: Array<{ id: number; advanceWidth: number; codePoints: number[] }> };
    glyphForCodePoint: (codePoint: number) => { id: number };
    hasGlyphForCodePoint: (codePoint: number) => boolean;
    createSubset: () => {
      includeGlyph: (glyph: { id: number } | number) => number;
      encode: () => Uint8Array;
    };
  }

  /**
   * Parse font bytes.
   *
   * @param data - font file contents.
   * @param postscriptName - face name, when the data is a collection.
   * @returns the parsed font.
   */
  export function create(data: Uint8Array, postscriptName?: string): FontkitFont;
}
