/** Original math glyph outlines, without replaying a complete source page. */
import { create } from 'fontkit';
import type { FontResolvablePage } from './pdfjs';
import type { Operators } from './graphics';
import type { MathGlyph, TextRun } from './types';

interface GlyphRecord { unicode: string; fontChar: string; width: number }
interface OutlineFont {
  unitsPerEm: number;
  glyphForCodePoint(cp: number): { id: number; path: { scale(x: number, y: number): { toSVG(): string } } };
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
        if (typeof glyph !== 'number' && glyph?.unicode && glyph.fontChar) glyphs.set(glyph.unicode, glyph);
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
    const encoded: GlyphRecord[] = [];
    for (const ch of run.text) {
      if (/\s/.test(ch)) {
        encoded.push({unicode: ch, fontChar: "", width: 250});
        continue;
      }
      const glyph = glyphs.get(ch);
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
