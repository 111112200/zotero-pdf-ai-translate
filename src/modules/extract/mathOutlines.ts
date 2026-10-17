/** Original math glyph outlines, without replaying a complete source page. */
import { create } from 'fontkit';
import { normalizeUnicode } from 'pdfjs-dist';
import type { FontResolvablePage } from './pdfjs';
import type { Operators } from './graphics';
import type { MathGlyph, TextRun } from './types';

interface GlyphRecord { unicode: string; fontChar: string; width: number }
interface OutlineFont {
  unitsPerEm: number;
  glyphForCodePoint(cp: number): { id: number; advanceWidth?: number; path: { scale(x: number, y: number): { toSVG(): string } } };
}

/** Build a per-page outline reader from resolved PDF fonts and encoded glyphs. */
export function mathOutlineReader(page: FontResolvablePage, list: Operators, ops: Record<string, number>): (run: TextRun) => MathGlyph[] | undefined {
  const records = new Map<string, Map<string,GlyphRecord>>();
  const fonts = new Map<string, OutlineFont | undefined>();
  let currentFont = '';
  const stack: string[] = [];
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i], args = list.argsArray[i];
    if (fn === ops.save || fn === ops.paintFormXObjectBegin) stack.push(currentFont);
    else if (fn === ops.restore || fn === ops.paintFormXObjectEnd) currentFont = stack.pop() ?? currentFont;
    else if (fn === ops.setFont) currentFont = args[0] as string;
    else if (fn === ops.showText) {
      let glyphs = records.get(currentFont);
      if (!glyphs) records.set(currentFont, glyphs = new Map());
      for (const glyph of args[0] as Array<GlyphRecord | number>) {
        // Text items normalize compatibility characters such as µ to μ; fontChar
        // still identifies the original glyph in the embedded font. Both the raw
        // and the normalized spelling are indexed, because a ligature normalizes
        // to two characters and would otherwise never match a one-character
        // lookup — which made the whole run look undecodable.
        if (typeof glyph !== 'number' && glyph?.unicode && glyph.fontChar) {
          if (!glyphs.has(glyph.unicode)) glyphs.set(glyph.unicode, glyph);
          const normalized = normalizeUnicode(glyph.unicode);
          if (!glyphs.has(normalized)) glyphs.set(normalized, glyph);
        }
      }
    }
  }
  return run => {
    const id = run.fontId;
    if (!id) return undefined;
    if (!fonts.has(id)) {
      try {
        const data = (page.commonObjs.get(id) as {data?: Uint8Array}).data;
        fonts.set(id, data ? create(data) as unknown as OutlineFont : undefined);
      } catch (error) {
        ztoolkit.log(`math font outline unavailable: ${id}`, error);
        fonts.set(id, undefined);
      }
    }
    const font = fonts.get(id), glyphs = records.get(id);
    if (!font || !glyphs) return undefined;
    // Whitespace still advances the pen. Its width comes from the font: the
    // hard-coded 250 units was only right at 1000 units per em, and shifted
    // every glyph after a space inside a multi-word formula on a 2048-unit font.
    let spaceWidth = font.unitsPerEm * 0.25;
    try {
      const space = font.glyphForCodePoint(0x20) as { advanceWidth?: number } | undefined;
      if (space?.advanceWidth) spaceWidth = space.advanceWidth;
    } catch {
      // Keep the 0.25 em estimate.
    }
    const encoded: GlyphRecord[] = [];
    for (const ch of run.text) {
      if (/\s/.test(ch)) {
        encoded.push({ unicode: ch, fontChar: "", width: spaceWidth });
        continue;
      }
      const glyph = glyphs.get(ch) ?? glyphs.get(normalizeUnicode(ch));
      if (!glyph) return undefined;
      encoded.push(glyph);
    }
    const totalAdvance = encoded.reduce((sum,g) => sum + g.width, 0);
    if (totalAdvance <= 0) return undefined;
    const result: MathGlyph[] = [];
    let x = 0;
    try {
      for (const encodedGlyph of encoded) {
        if (!encodedGlyph.fontChar) {
          x += encodedGlyph.width / totalAdvance * run.width;
          continue;
        }
        const glyph = font.glyphForCodePoint(encodedGlyph.fontChar.codePointAt(0)!);
        if (glyph.id === 0) return undefined;
        const scale = run.fontSize / font.unitsPerEm;
        result.push({path: glyph.path.scale(scale,-scale).toSVG(), x});
        x += encodedGlyph.width / totalAdvance * run.width;
      }
    } catch (error) {
      ztoolkit.log(`math glyph outline unavailable: ${id}`, error);
      return undefined;
    }
    return result;
  };
}
