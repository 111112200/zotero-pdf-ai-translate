/**
 * Side-by-side bilingual PDF composition.
 *
 * Each source page becomes one output page of double width. The original page is
 * embedded on the left untouched, and again on the right with its text replaced
 * by the translation.
 *
 * Drawing the original page into the right half is what preserves figures and
 * formulas: they are part of the page's own content, so they survive by
 * construction. Only the boxes the text actually occupies are covered, and only
 * for paragraphs that were translated, so display equations and every graphic
 * element stay exactly where they were.
 *
 * Because a paragraph is drawn back into its own box, the page keeps its column
 * structure: a paragraph that sat in the left column of a two-column paper is
 * still in the left column.
 */

import { degrees, PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { getPref } from "../../utils/prefs";
import { uprightPlacement } from "../extract/geometry";
import type { Box, PageContent } from "../extract/types";
import { findMissingGlyphs, loadTranslationFont } from "./fonts";
import { pdfLibFontkit } from "./fontkit";
import { fitParagraph } from "./inline";
import { touches } from "../extract/graphics";

export interface RenderInput {
  /** Original PDF bytes; every page is embedded twice. */
  sourceBytes: Uint8Array;
  /** Extracted structure, one entry per source page. */
  pages: PageContent[];
  /** Translated paragraph text keyed by `pageIndex:paragraphIndex`. */
  translations: Map<string, string>;
  /** Called after each page is composed, for progress reporting. */
  onPage?: (pageNumber: number, total: number) => void;
  signal?: AbortSignal;
  /** Collect per-paragraph decisions; used by the offline layout harness. */
  debug?: boolean;
}

export interface RenderResult {
  bytes: Uint8Array;
  /** Paragraphs whose translation did not fit its original box. */
  overflowBoxes: number;
  /** Characters the font could not render; they appear as blanks. */
  missingGlyphs: string[];
  /** Pages that were not translated because the layout could not be matched. */
  skippedPages: number[];
  /** Paragraphs retained because an original math font could not be decoded. */
  preservedMathParagraphs: number;
  /** Per-paragraph decisions, populated only when `debug` is set. */
  debug: ParagraphDecision[];
}

/** What the renderer decided for one paragraph. */
export interface ParagraphDecision {
  page: number;
  index: number;
  column: number;
  formulaBlock: boolean;
  translated: boolean;
  box: Box;
  lineBoxes: number;
  fontPt: number;
  lines: number;
  truncated: number;
}

const COLORS = {
  ink: rgb(0.09, 0.09, 0.11),
  /** Not pure white: matching the page background avoids a visible patch on tinted pages. */
  cover: rgb(1, 1, 1),
  divider: rgb(0.78, 0.78, 0.8),
};

/** Extra room added around an original line when covering it. */
const COVER_PADDING = { left: 1.2, right: 2.5, top: 1.6, bottom: 2.0 };


/**
 * Compose the bilingual document.
 *
 * @param input - source bytes, extracted pages and translations.
 * @returns the finished PDF together with any layout warnings.
 * @throws when the source PDF cannot be parsed or no font is available.
 */
export async function renderBilingual(input: RenderInput): Promise<RenderResult> {
  const fontBytes = await loadTranslationFont();
  if (!fontBytes) {
    throw new Error(
      "No translation font available. Check the plugin settings or reinstall it.",
    );
  }

  const source = await PDFDocument.load(input.sourceBytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const output = await PDFDocument.create();
  // fontkit 2 through the adapter, not @pdf-lib/fontkit: fontkit 1.x silently
  // drops outlines from any subset that needs a long `loca` table, which is
  // every CJK font. See modules/render/fontkit.ts.
  output.registerFontkit(pdfLibFontkit as never);
  const font = await output.embedFont(fontBytes, { subset: true });

  const embedded = await output.embedPdf(source, source.getPageIndices());

  const gap = getPref<number>("columnGapPt") || 12;
  const drawDivider = getPref<boolean>("drawDivider") !== false;
  const originalOnLeft = getPref<boolean>("originalOnLeft") !== false;

  const drawn: string[] = [];
  const skippedPages: number[] = [];
  const decisions: ParagraphDecision[] = [];
  let overflowBoxes = 0;
  let preservedMathParagraphs = 0;
  const total = input.pages.length;

  input.pages.forEach((page, index) => {
    if (input.signal?.aborted) {
      return;
    }
    const sourcePage = source.getPage(page.index);
    const geometry = {
      userWidth: sourcePage.getWidth(),
      userHeight: sourcePage.getHeight(),
      rotate: page.rotate as 0 | 90 | 180 | 270,
      width: page.width,
      height: page.height,
      toNormalized: (x: number, y: number) => ({ x, y }),
    };
    const placement = uprightPlacement(geometry);
    const out = output.addPage([page.width * 2 + gap, page.height]);

    const originalX = originalOnLeft ? 0 : page.width + gap;
    const translatedX = originalOnLeft ? page.width + gap : 0;

    drawSourcePage(out, embedded[page.index], placement, originalX);
    drawSourcePage(out, embedded[page.index], placement, translatedX);

    if (drawDivider) {
      const dividerX = page.width + gap / 2;
      out.drawLine({
        start: { x: dividerX, y: 0 },
        end: { x: dividerX, y: page.height },
        thickness: 0.5,
        color: COLORS.divider,
      });
    }

    const result = overlayTranslations({
      out,
      page,
      translatedX,
      font,
      translations: input.translations,
      drawn,
      decisions: input.debug ? decisions : undefined,
    });
    overflowBoxes += result.overflows;
    preservedMathParagraphs += result.preservedMath;

    input.onPage?.(index + 1, total);
  });

  setProducer(output);
  const bytes = await output.save({ useObjectStreams: true });
  return {
    bytes,
    overflowBoxes,
    missingGlyphs: findMissingGlyphs(fontBytes, drawn.join("")),
    skippedPages,
    preservedMathParagraphs,
    debug: decisions,
  };
}

/** Draw the upright source page at a horizontal offset. */
function drawSourcePage(
  out: PDFPage,
  embeddedPage: Parameters<PDFPage["drawPage"]>[0],
  placement: ReturnType<typeof uprightPlacement>,
  offsetX: number,
): void {
  out.drawPage(embeddedPage, {
    x: offsetX + placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    ...(placement.rotationDegrees
      ? { rotate: degrees(placement.rotationDegrees) }
      : {}),
  });
}

interface OverlayArgs {
  out: PDFPage;
  page: PageContent;
  /** Horizontal offset of the translated half, in output points. */
  translatedX: number;
  font: PDFFont;
  translations: Map<string, string>;
  drawn: string[];
  decisions?: ParagraphDecision[];
}

/**
 * Cover each translated paragraph and draw its translation into the same box.
 *
 * @returns how many paragraphs could not be made to fit.
 */
function overlayTranslations(args: OverlayArgs): { overflows: number; preservedMath: number } {
  const {
    out,
    page,
    translatedX,
    font,
    translations,
    drawn,
    decisions,
  } = args;

  let overflows = 0;
  let preservedMath = 0;
  const height = page.height;
  /** toPdfY turns a normalized top-down coordinate into a PDF bottom-up one. */
  const toPdfY = (y: number) => height - y;

  page.paragraphs.forEach((paragraph, index) => {
    const record = (entry: Omit<ParagraphDecision, "page" | "index" | "box" | "column">) => {
      decisions?.push({
        page: page.index,
        index,
        column: paragraph.column,
        box: paragraph.box,
        ...entry,
      });
    };

    if (paragraph.isFormulaBlock) {
      // Display equations keep their original typesetting: they are already
      // correct, and re-drawing them would lose the math fonts.
      record({ formulaBlock: true, translated: false, lineBoxes: 0, fontPt: 0, lines: 0, truncated: 0 });
      return;
    }
    const translated = translations.get(`${page.index}:${index}`);
    if (translated === undefined) {
      record({ formulaBlock: false, translated: false, lineBoxes: paragraph.lineBoxes.length, fontPt: 0, lines: 0, truncated: 0 });
      return;
    }
    const text = translated.replace(/\s+/g, " ").trim();
    if (!text.trim()) {
      record({ formulaBlock: false, translated: false, lineBoxes: paragraph.lineBoxes.length, fontPt: 0, lines: 0, truncated: 0 });
      return;
    }

    if (paragraph.math.some(span => span.token && !span.outlines)) {
      preservedMath++;
      record({ formulaBlock: false, translated: false, lineBoxes: paragraph.lineBoxes.length, fontPt: 0, lines: 0, truncated: 0 });
      return;
    }

    const fit = fitParagraph(text, paragraph, font);
    const blocked = (page.protectedRegions ?? []).some(box => touches(paragraph.box, box, 2.5));
    if (!fit.fits || blocked) {
      overflows += fit.fits ? 0 : 1;
      record({ formulaBlock: false, translated: false, lineBoxes: paragraph.lineBoxes.length, fontPt: fit.size, lines: 0, truncated: 0 });
      return;
    }
    for (const box of paragraph.lineBoxes) drawCover(out, box, translatedX, toPdfY);
    const { size, lines, leading } = fit;
    // The first baseline follows the fitted glyph height; the remaining lines
    // distribute over the source paragraph's vertical extent.
    let y = paragraph.box.top + size * 0.9;
    for (const line of lines) {
      let x = translatedX + paragraph.box.left;
      for (const piece of line) {
        if (piece.math?.box) {
          const scale = size / paragraph.fontSize;
          for (const glyph of piece.math.outlines ?? []) {
            if (glyph.path) out.drawSvgPath(glyph.path, {x: x + glyph.x * scale, y: toPdfY(y), scale, color: COLORS.ink});
          }
        } else if (piece.text) {
          drawTextLine(out, piece.text, font, size, x, toPdfY(y));
          drawn.push(piece.text);
        }
        x += piece.width;
      }
      y += leading;
    }
    record({ formulaBlock: false, translated: true, lineBoxes: paragraph.lineBoxes.length, fontPt: size, lines: lines.length, truncated: 0 });
  });

  return { overflows, preservedMath };
}

/** Paint the page background over one original line box. */
function drawCover(
  out: PDFPage,
  box: Box,
  offsetX: number,
  toPdfY: (y: number) => number,
): void {
  const width = box.right - box.left + COVER_PADDING.left + COVER_PADDING.right;
  const height = box.bottom - box.top + COVER_PADDING.top + COVER_PADDING.bottom;
  out.drawRectangle({
    x: offsetX + box.left - COVER_PADDING.left,
    y: toPdfY(box.bottom + COVER_PADDING.bottom),
    width,
    height,
    color: COLORS.cover,
  });
}

/** Draw one line of translated text, degrading per character on failure. */
function drawTextLine(
  out: PDFPage,
  line: string,
  font: PDFFont,
  size: number,
  x: number,
  y: number,
): void {
  try {
    out.drawText(line, { x, y, size, font, color: COLORS.ink });
  } catch (error) {
    // A character outside the font's coverage aborts the whole draw call, so
    // fall back to placing what can be placed rather than losing the line.
    ztoolkit.log(`could not draw: ${line.slice(0, 40)}…`, error);
    let placed = "";
    for (const ch of line) {
      try {
        out.drawText(ch, {
          x: x + font.widthOfTextAtSize(placed, size),
          y,
          size,
          font,
          color: COLORS.ink,
        });
        placed += ch;
      } catch {
        placed += " ";
      }
    }
  }
}

/** Record that the file was produced by this plugin, for support and provenance. */
function setProducer(doc: PDFDocument): void {
  try {
    doc.setProducer(`PDF AI Translate ${buildVersion}`);
    doc.setCreator(`PDF AI Translate ${buildVersion}`);
  } catch (error) {
    ztoolkit.log("could not set PDF metadata", error);
  }
}
