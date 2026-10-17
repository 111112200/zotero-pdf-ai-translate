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

import { degrees, PDFDocument, rgb, pushGraphicsState, popGraphicsState, setLineWidth, setTextRenderingMode, TextRenderingMode, setStrokingColor, type PDFFont, type PDFPage } from "pdf-lib";
import { getPref } from "../../utils/prefs";
import { uprightPlacement } from "../extract/geometry";
import type { Box, PageContent, ShadedRegion } from "../extract/types";
import { findMissingGlyphs, loadTranslationFont } from "./fonts";
import { fontHasGlyph, pdfLibFontkit } from "./fontkit";
import { fitParagraph, placeholdersBreak } from "./inline";
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
  /** Paragraphs retained because the reply mangled a formula placeholder. */
  placeholderMismatches: number;
  /** Paragraphs the model returned unchanged, so they kept the source language. */
  unchangedParagraphs: number;
  /** Paragraphs that could not be typeset at all and kept their original text. */
  renderErrors: number;
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
  /** Why a translatable paragraph was retained, when applicable. */
  reason?: "untranslated" | "unchanged" | "unsupported-math" | "placeholder" | "overflow" | "protected" | "error";
}

const COLORS = {
  ink: rgb(0.09, 0.09, 0.11),
  divider: rgb(0.78, 0.78, 0.8),
};

/**
 * Colour to paint a cover with.
 *
 * A white cover is only invisible on a white page. The smallest recorded fill
 * whose area contains the cover's centre is the background the text actually
 * sits on — a tinted page, a shaded table row, a coloured band — so the cover
 * takes that colour instead of punching a white hole in it.
 *
 * @param cover - the rectangle about to be painted.
 * @param regions - non-white fills recorded for this page, largest first.
 * @returns the fill colour for the cover, white when nothing was recorded.
 */
function coverColor(cover: Box, regions: ShadedRegion[]): [number, number, number] {
  const x = (cover.left + cover.right) / 2;
  const y = (cover.top + cover.bottom) / 2;
  let best: ShadedRegion | undefined;
  let bestArea = Infinity;
  for (const region of regions) {
    const { box } = region;
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) {
      continue;
    }
    const area = (box.right - box.left) * (box.bottom - box.top);
    if (area < bestArea) {
      bestArea = area;
      best = region;
    }
  }
  return best ? best.color : [1, 1, 1];
}

/** Extra room added around an original line when covering it. */
const COVER_PADDING = { left: 1.2, right: 2.5, top: 1.6, bottom: 2.0 };

/**
 * The source page's visible box in user space, as `[x0, y0, x1, y1]`.
 *
 * Falls back to a box anchored at the origin when the extraction predates
 * `PageContent.view` (e.g. a structure dump written by the layout harness), in
 * which case the `/Rotate` swap has to be undone to recover user-space units.
 *
 * @param page - extracted page content.
 * @returns the box to embed and to measure coordinates against.
 */
function pageViewBox(page: PageContent): [number, number, number, number] {
  const view = page.view;
  if (Array.isArray(view) && view.length === 4 && view.every((value) => Number.isFinite(value))) {
    return [view[0], view[1], view[2], view[3]];
  }
  const swapped = page.rotate === 90 || page.rotate === 270;
  return [0, 0, swapped ? page.height : page.width, swapped ? page.width : page.height];
}


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

  // Embed every page through its own visible box. `embedPdf` would use pdf-lib's
  // own MediaBox-based box with an identity matrix, which silently discards the
  // box origin: the drawn copy then sits at raw user coordinates while the
  // extractor measured everything relative to the box corner. On any page whose
  // MediaBox origin is not (0, 0) — or whose CropBox differs from its MediaBox —
  // that put the translation beside the original text instead of on top of it.
  const embedded = await Promise.all(
    input.pages.map((page) => {
      const [x0, y0, x1, y1] = pageViewBox(page);
      return output.embedPage(
        source.getPage(page.index),
        { left: 0, bottom: 0, right: x1 - x0, top: y1 - y0 },
        [1, 0, 0, 1, -x0, -y0],
      );
    }),
  );

  const gap = getPref<number>("columnGapPt") || 12;
  const drawDivider = getPref<boolean>("drawDivider") !== false;
  const originalOnLeft = getPref<boolean>("originalOnLeft") !== false;

  const drawn: string[] = [];
  const skippedPages: number[] = [];
  const decisions: ParagraphDecision[] = [];
  let overflowBoxes = 0;
  let preservedMathParagraphs = 0;
  let placeholderMismatches = 0;
  let renderErrors = 0;
  let unchangedParagraphs = 0;
  const total = input.pages.length;

  // One coverage query per font, reused for every line drawn below.
  const glyphFont = pdfLibFontkit.create(fontBytes);
  const draws = (ch: string) => fontHasGlyph(glyphFont, ch.codePointAt(0) ?? 0);

  input.pages.forEach((page, index) => {
    if (input.signal?.aborted) {
      return;
    }
    // Both halves and every overlay coordinate share this frame: the visible
    // box of the source page, unrotated, in user-space units.
    const [boxLeft, boxBottom, boxRight, boxTop] = pageViewBox(page);
    const geometry = {
      userWidth: boxRight - boxLeft,
      userHeight: boxTop - boxBottom,
      rotate: page.rotate as 0 | 90 | 180 | 270,
      width: page.width,
      height: page.height,
      toNormalized: (x: number, y: number) => ({ x, y }),
    };
    const placement = uprightPlacement(geometry);
    const out = output.addPage([page.width * 2 + gap, page.height]);

    const originalX = originalOnLeft ? 0 : page.width + gap;
    const translatedX = originalOnLeft ? page.width + gap : 0;

    drawSourcePage(out, embedded[index], placement, originalX);
    drawSourcePage(out, embedded[index], placement, translatedX);

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
      draws,
      decisions: input.debug ? decisions : undefined,
    });
    overflowBoxes += result.overflows;
    preservedMathParagraphs += result.preservedMath;
    placeholderMismatches += result.placeholderMismatches;
    renderErrors += result.renderErrors;
    unchangedParagraphs += result.unchanged;
    if (page.skipped || (page.paragraphs.length > 0 && !result.translatedAny)) {
      skippedPages.push(page.index);
    }

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
    placeholderMismatches,
    unchangedParagraphs,
    renderErrors,
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
  /** True when the translation font can render a character. */
  draws: (ch: string) => boolean;
  decisions?: ParagraphDecision[];
}

/**
 * Cover each translated paragraph and draw its translation into the same box.
 *
 * @returns how many paragraphs could not be made to fit, and the page totals the
 *   caller reports to the user.
 */
function overlayTranslations(args: OverlayArgs): {
  overflows: number;
  preservedMath: number;
  placeholderMismatches: number;
  renderErrors: number;
  unchanged: number;
  translatedAny: boolean;
} {
  const {
    out,
    page,
    translatedX,
    font,
    translations,
    drawn,
    draws,
    decisions,
  } = args;

  let overflows = 0;
  let preservedMath = 0;
  let placeholderMismatches = 0;
  let renderErrors = 0;
  let unchanged = 0;
  let translatedAny = false;
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
      record({ formulaBlock: false, translated: false, lineBoxes: paragraph.lineBoxes.length, fontPt: 0, lines: 0, truncated: 0, reason: "untranslated" });
      return;
    }
    const text = translated.replace(/\s+/g, " ").trim();
    if (!text.trim()) {
      record({ formulaBlock: false, translated: false, lineBoxes: paragraph.lineBoxes.length, fontPt: 0, lines: 0, truncated: 0 });
      return;
    }
    if (text.replace(/\s/g, "") === paragraph.source.replace(/\s/g, "")) {
      // The model echoed the source: the paragraph keeps its original language,
      // which is right for references and author blocks, but is worth reporting
      // because a mixed-language page is otherwise indistinguishable from a
      // fully translated one.
      unchanged++;
      record({ formulaBlock: false, translated: false, lineBoxes: 0, fontPt: 0, lines: 0, truncated: 0, reason: "unchanged" });
      return;
    }

    if (paragraph.math.some(span => span.token && !span.outlines)) {
      preservedMath++;
      record({ formulaBlock: false, translated: false, lineBoxes: paragraph.lineBoxes.length, fontPt: 0, lines: 0, truncated: 0, reason: "unsupported-math" });
      return;
    }

    // Tokens that no longer match the source would either lose an equation, draw
    // one twice, or be typeset as literal characters (the bundled font has no
    // `⟦`/`⟧`, so they show up as blank boxes) while the formula they stood for
    // has already been covered. Keep the original instead.
    if (placeholdersBreak(paragraph.source, text, paragraph)) {
      placeholderMismatches++;
      record({ formulaBlock: false, translated: false, lineBoxes: paragraph.lineBoxes.length, fontPt: 0, lines: 0, truncated: 0, reason: "placeholder" });
      return;
    }

    const placement = { ...paragraph.box };
    let blocked = false;
    for (const region of page.protectedRegions ?? []) {
      if (!touches(placement, region)) continue;
      if (region.top >= placement.bottom - paragraph.fontSize && region.bottom >= placement.bottom) placement.bottom = region.top - 0.5;
      else if (region.bottom <= placement.top + paragraph.fontSize && region.top <= placement.top) placement.top = region.bottom + 0.5;
      else blocked = true;
    }
    // Wrapping and measuring are pure geometry, but a malformed paragraph should
    // cost one paragraph, not the whole export.
    let fit: ReturnType<typeof fitParagraph>;
    try {
      fit = fitParagraph(text, { ...paragraph, box: placement }, font);
    } catch (error) {
      ztoolkit.log(`paragraph ${page.index}:${index} could not be measured`, error);
      renderErrors++;
      record({ formulaBlock: false, translated: false, lineBoxes: paragraph.lineBoxes.length, fontPt: 0, lines: 0, truncated: 0, reason: "error" });
      return;
    }
    if (!fit.fits || blocked) {
      overflows += fit.fits ? 0 : 1;
      record({ formulaBlock: false, translated: false, lineBoxes: paragraph.lineBoxes.length, fontPt: fit.size, lines: 0, truncated: 0, reason: fit.fits ? "protected" : "overflow" });
      return;
    }
    const { size, lines, leading } = fit;
    try {
      for (const box of paragraph.lineBoxes) drawCover(out, box, translatedX, toPdfY, page.protectedRegions ?? [], page.shadedRegions ?? []);
      // The first baseline follows the fitted glyph height; the remaining lines
      // distribute over the source paragraph's vertical extent.
      let y = placement.top + fit.baselineOffset;
      if (paragraph.bold) out.pushOperators(pushGraphicsState(), setLineWidth(size * 0.018), setStrokingColor(COLORS.ink), setTextRenderingMode(TextRenderingMode.FillAndOutline));
      for (const line of lines) {
        let x = translatedX + paragraph.box.left;
        if (paragraph.alignment === "center") x += (paragraph.box.right - paragraph.box.left - line.reduce((sum, piece) => sum + piece.width, 0)) / 2;
        for (const piece of line) {
          if (piece.math?.box) {
            const scale = size / paragraph.fontSize;
            for (const glyph of piece.math.outlines ?? []) {
              if (glyph.path) out.drawSvgPath(glyph.path, {x: x + glyph.x * scale, y: toPdfY(y + (glyph.y ?? 0) * scale), scale, color: COLORS.ink});
            }
          } else if (piece.text) {
            drawTextLine(out, piece.text, font, size, x, toPdfY(y), draws, drawn);
          }
          x += piece.width;
        }
        y += leading;
      }
      if (paragraph.bold) out.pushOperators(popGraphicsState());
    } catch (error) {
      ztoolkit.log(`paragraph ${page.index}:${index} could not be typeset`, error);
      renderErrors++;
      record({ formulaBlock: false, translated: false, lineBoxes: paragraph.lineBoxes.length, fontPt: fit.size, lines: 0, truncated: 0, reason: "error" });
      return;
    }
    translatedAny = true;
    record({ formulaBlock: false, translated: true, lineBoxes: paragraph.lineBoxes.length, fontPt: size, lines: lines.length, truncated: 0 });
  });

  return { overflows, preservedMath, placeholderMismatches, renderErrors, unchanged, translatedAny };
}

/** Paint the page background over one original line box. */
function drawCover(
  out: PDFPage,
  box: Box,
  offsetX: number,
  toPdfY: (y: number) => number,
  protectedRegions: Box[],
  shadedRegions: ShadedRegion[],
): void {
  let covers = [{ left: box.left - COVER_PADDING.left, right: box.right + COVER_PADDING.right, top: box.top - COVER_PADDING.top, bottom: box.bottom + COVER_PADDING.bottom }];
  for (const region of protectedRegions) {
    covers = covers.flatMap(cover => {
      const left = Math.max(cover.left, region.left), right = Math.min(cover.right, region.right);
      const top = Math.max(cover.top, region.top), bottom = Math.min(cover.bottom, region.bottom);
      if (left >= right || top >= bottom) return [cover];
      return [
        { ...cover, bottom: top }, { ...cover, top: bottom },
        { left: cover.left, right: left, top, bottom }, { left: right, right: cover.right, top, bottom },
      ].filter(part => part.right > part.left && part.bottom > part.top);
    });
  }
  for (const cover of covers) {
    const [r, g, b] = coverColor(cover, shadedRegions);
    out.drawRectangle({ x: offsetX + cover.left, y: toPdfY(cover.bottom), width: cover.right - cover.left, height: cover.bottom - cover.top, color: rgb(r, g, b) });
  }
}

/**
 * Draw one line of translated text.
 *
 * Characters the font cannot render are replaced by a space rather than left to
 * pdf-lib: it does not throw for an unmapped character, it embeds `.notdef`,
 * which every reader shows as a hollow box. The replacement is only cosmetic —
 * the original text is still pushed through {@link drawn} so the caller keeps
 * reporting exactly which characters are missing.
 *
 * @param out - page being composed.
 * @param line - text to draw.
 * @param font - translation font.
 * @param size - font size in points.
 * @param x - left edge of the line.
 * @param y - baseline position.
 * @param draws - true when the font can render the character.
 * @param drawn - collects the text actually typeset, unmapped characters included.
 */
function drawTextLine(
  out: PDFPage,
  line: string,
  font: PDFFont,
  size: number,
  x: number,
  y: number,
  draws: (ch: string) => boolean,
  drawn: string[],
): void {
  let text = "";
  for (const ch of line) {
    text += draws(ch) ? ch : " ";
  }
  drawn.push(line);
  if (!text.trim()) {
    return;
  }
  try {
    out.drawText(text, { x, y, size, font, color: COLORS.ink });
  } catch (error) {
    // Last resort: place what can be placed rather than losing the whole line.
    ztoolkit.log(`could not draw: ${text.slice(0, 40)}…`, error);
    let placed = "";
    for (const ch of text) {
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
