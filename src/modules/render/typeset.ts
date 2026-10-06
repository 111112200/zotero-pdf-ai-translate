/**
 * Typesetting helpers for the translated column.
 *
 * Line breaking has to be script aware: CJK text may break between any two
 * characters, while Latin text only breaks at spaces and hyphens. pdf-lib's
 * `drawText` has no wrapping at all, so the break is computed here and each line
 * is positioned by hand.
 */

import type { PDFFont } from "pdf-lib";

/** Matches the scripts that allow a line break between any two characters. */
const CJK =
  /[\u1100-\u11ff\u2e80-\u303f\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe10-\ufe1f\ufe30-\ufe4f\uff00-\uffef]/;

/** True when a character may start a new line on its own. */
export function isCJK(ch: string): boolean {
  return CJK.test(ch);
}

/**
 * Break text into lines that fit `maxWidth`.
 *
 * @param text - paragraph text; embedded newlines are honored.
 * @param font - font used for measurement.
 * @param size - font size in points.
 * @param maxWidth - available width in points.
 * @returns one string per rendered line.
 */
export function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    wrapParagraph(paragraph, font, size, maxWidth, lines);
  }
  return lines;
}

/** Wrap one paragraph, appending to `out`. */
function wrapParagraph(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
  out: string[],
): void {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return;
  }

  let line = "";
  let token = "";

  const measure = (value: string): number => font.widthOfTextAtSize(value, size);

  const flushToken = () => {
    if (!token) {
      return;
    }
    if (!line || measure(line + token) <= maxWidth) {
      line += token;
    } else {
      out.push(line);
      line = token.replace(/^\s+/, "");
    }
    token = "";
  };

  for (const ch of trimmed) {
    if (isCJK(ch)) {
      flushToken();
      token = ch;
      flushToken();
    } else if (ch === " ") {
      token += " ";
      flushToken();
    } else {
      token += ch;
    }
  }
  flushToken();
  if (line) {
    out.push(line);
  }
}

/**
 * Split a token-bearing paragraph so that an over-long word cannot overflow.
 *
 * @param token - a word that is wider than the column.
 * @param font - font used for measurement.
 * @param size - font size in points.
 * @param maxWidth - available width in points.
 * @returns the word split into fitting pieces.
 */
export function breakLongToken(
  token: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const pieces: string[] = [];
  let piece = "";
  for (const ch of token) {
    if (piece && font.widthOfTextAtSize(piece + ch, size) > maxWidth) {
      pieces.push(piece);
      piece = ch;
    } else {
      piece += ch;
    }
  }
  if (piece) {
    pieces.push(piece);
  }
  return pieces;
}

export interface LayoutBudget {
  /** Height available between the top and bottom margins, in points. */
  available: number;
  /** Line height for the chosen size. */
  leading: number;
}

/**
 * Compute how much vertical space a block of lines needs.
 *
 * @param lineCount - number of rendered lines.
 * @param size - font size in points.
 * @param leadingFactor - line height as a multiple of the font size.
 * @param paragraphGapFactor - paragraph gap as a multiple of the line height.
 * @param paragraphCount - number of paragraphs, used for the trailing gaps.
 * @returns the required height in points.
 */
export function requiredHeight(
  lineCount: number,
  size: number,
  leadingFactor: number,
  paragraphGapFactor: number,
  paragraphCount: number,
): number {
  const leading = size * leadingFactor;
  return lineCount * leading + paragraphCount * leading * paragraphGapFactor;
}

/**
 * Pick the largest font size that fits a page, shrinking in 0.5pt steps.
 *
 * @param sizes - candidate sizes, largest first.
 * @param measure - returns the height needed at a given size.
 * @param available - height available on the page.
 * @returns the chosen size and whether it fit without overflowing.
 */
export function fitFontSize(
  sizes: number[],
  measure: (size: number) => number,
  available: number,
): { size: number; fits: boolean } {
  for (const size of sizes) {
    if (measure(size) <= available) {
      return { size, fits: true };
    }
  }
  return { size: sizes[sizes.length - 1], fits: false };
}

/**
 * Descending candidate sizes derived from the user's preference.
 *
 * @param preferred - the preferred size in points.
 * @param minimum - the smallest size worth rendering.
 * @param autoShrink - when false only the preferred size is returned.
 * @returns sizes from largest to smallest.
 */
export function candidateSizes(
  preferred: number,
  minimum: number,
  autoShrink: boolean,
): number[] {
  if (!autoShrink) {
    return [preferred];
  }
  const sizes: number[] = [];
  for (let size = preferred; size >= minimum - 1e-6; size -= 0.5) {
    sizes.push(Math.round(size * 10) / 10);
  }
  return sizes.length ? sizes : [preferred];
}
