/**
 * Formula detection.
 *
 * Measured on a real 9-page LaTeX paper: Unicode ranges alone are almost
 * useless, because LaTeX sets `x`, `w`, `R`, `Q` in a math font while leaving
 * them at ordinary Latin code points (45 450 characters in normal fonts had a
 * math-symbol ratio of 0, none reached 0.25). The embedded font name is the
 * only decisive signal, which is why Zotero's bundled pdf.js is used for
 * extraction rather than a plain text dump.
 *
 * The font patterns follow PDFMathTranslate (`pdf2zh/converter.py`) and
 * BabelDOC (`formular_helper.py`), with BabelDOC's exclusions for modern
 * text-quality math fonts that render prose.
 */

import type { MathSpan, TextLine, TextRun } from "./types";

/** Fonts that indicate mathematical typesetting. */
const MATH_FONT_PATTERN = new RegExp(
  [
    "CM[^R]", // Computer Modern maths (CMMI, CMSY, CMEX); CMR is body text
    "MS[AM]M", // AMS maths
    "MT(MI|SY|EX)", // MathTime
    "XY", // XY-pic
    "EUSM|EUFM|RSFS|WASY", // LaTeX symbol and script fonts
    "Math", // CambriaMath, LatinModernMath, STIXMath, XITSMath, FiraMath…
    "STIX",
    "Symbol",
    "MathematicalPi",
    "TeX-",
    "LMMath",
    "NewCM",
    "KpMath",
    "Libertinus.*Math",
  ].join("|"),
  "i",
);

/**
 * Fonts that look mathematical but are routinely used for body text, so a name
 * match alone must not flag them. BabelDOC maintains the same exclusion list.
 */
const MATH_FONT_EXCLUSION = new RegExp(
  [
    "Cambria(?!Math)",
    "Arial",
    "TimesNewRoman",
    "Times",
    "Calibri",
    "Helvetica",
    "NimbusRom",
    "Mincho",
    "Mono",
    "Code",
    "Symbola",
  ].join("|"),
  "i",
);

/** Unicode ranges whose characters are mathematical by codepoint. */
const MATH_RANGES: Array<[number, number]> = [
  [0x0370, 0x03ff], // Greek
  [0x1d400, 0x1d7ff], // mathematical alphanumeric symbols
  [0x2061, 0x2064], // invisible operators
  [0x2200, 0x22ff], // mathematical operators
  [0x27c0, 0x27ef], // miscellaneous mathematical symbols-A
  [0x2980, 0x29ff], // miscellaneous mathematical symbols-B
  [0x2a00, 0x2aff], // supplemental mathematical operators
];

/** Share of a line's characters that must come from maths for it to be a formula. */
const LINE_MATH_SHARE_THRESHOLD = 0.5;

/**
 * Classify a single run.
 *
 * @param run - the run to test.
 * @returns true when the run should be excluded from translation.
 */
export function isMathRun(run: TextRun): boolean {
  const font = stripSubsetPrefix(run.fontName);
  if (font && MATH_FONT_PATTERN.test(font) && !MATH_FONT_EXCLUSION.test(font)) {
    return true;
  }
  const text = run.text;
  if (!text) {
    return false;
  }
  let mathChars = 0;
  let letters = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (MATH_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) {
      mathChars++;
    } else if (/[A-Za-z]/.test(ch)) {
      letters++;
    }
  }
  if (mathChars >= 3 && mathChars / Math.max(text.length, 1) >= 0.5) {
    return true;
  }
  // A short run with symbols but no word-like content is an operator fragment.
  return letters === 0 && mathChars > 0 && text.length <= 4;
}

/** Drop the `ABCDEF+` subset prefix pdf.js keeps in embedded font names. */
function stripSubsetPrefix(fontName: string): string {
  const plus = fontName.indexOf("+");
  return plus === 0 ? fontName.slice(1) : plus > 0 ? fontName.slice(plus + 1) : fontName;
}

/**
 * Share of a line's characters that come from runs classified as maths.
 *
 * @param line - the line to score.
 * @returns a value in `[0, 1]`.
 */
export function lineMathShare(line: TextLine): number {
  let total = 0;
  let math = 0;
  for (const run of line.runs) {
    total += run.text.length;
    if (run.isMath) {
      math += run.text.length;
    }
  }
  return total === 0 ? 0 : math / total;
}

/**
 * Decide whether a whole line is a display formula.
 *
 * A line is treated as display maths when most of its characters are maths, or
 * when it contains no word of three or more letters at all (a bare symbol row
 * such as a matrix or a numbered equation).
 *
 * @param line - the line to test.
 * @returns true when the line should be reproduced verbatim instead of translated.
 */
export function isDisplayFormula(line: TextLine): boolean {
  if (lineMathShare(line) >= LINE_MATH_SHARE_THRESHOLD) {
    return true;
  }
  const words = line.text.match(/[\p{L}]{3,}/gu);
  return !words && /\S/.test(line.text) && line.text.length <= 80;
}

/**
 * Replace maths runs inside a line with placeholder tokens.
 *
 * The model is told to keep tokens untouched, so a formula survives translation
 * as an opaque atom and is restored next to the translated sentence.
 *
 * @param line - the line to rewrite.
 * @param sink - collects each placeholder together with its original text.
 * @returns the line text with placeholders substituted.
 */
export function extractMathPlaceholders(
  line: TextLine,
  sink: MathSpan[],
): string {
  const parts: string[] = [];
  for (const run of line.runs) {
    if (run.isMath) {
      const text = run.text.trim();
      if (!text) {
        continue;
      }
      const token = `⟦M${sink.length + 1}⟧`;
      sink.push({ token, text, outlines: run.outlines, fontSize: run.fontSize, box: { left: run.x, top: run.y, right: run.x + run.width, bottom: run.y + run.height } });
      parts.push(token);
    } else {
      parts.push(run.text);
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

