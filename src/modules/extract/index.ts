/**
 * Page extraction: bytes in, translatable paragraphs with their geometry out.
 *
 * Runs entirely in the plugin process using the plugin’s bundled pdf.js, so no
 * external tooling is involved.
 */

import {
  extractMathPlaceholders,
  isDisplayFormula,
  isMathRun,
} from "./formulas";
import { graphicRegions, insideGraphic, textTableRegions, type Operators } from "./graphics";
import { mathOutlineReader } from "./mathOutlines";
import { pageGeometry } from "./geometry";
import {
  buildLines,
  lineBox,
  lineFontSize,
  toParagraphs,
  toReadingOrder,
  toRuns,
} from "./layout";
import { openDocument, pdfjsOps, resolveFontName } from "./pdfjs";
import type { Box, MathSpan, PageContent, Paragraph, TextLine } from "./types";

/** Raster image paint operations, used to count figures on a page. */
const IMAGE_OP_NAMES = [
  "paintImageXObject",
  "paintJpegXObject",
  "paintInlineImageXObject",
  "paintImageMaskXObject",
] as const;

interface PageLike {
  view: number[];
  rotate: number;
  getTextContent: (options?: Record<string, unknown>) => Promise<{
    items: Array<{
      str: string;
      width?: number;
      height?: number;
      transform?: number[];
      fontName?: string;
    }>;
  }>;
  getOperatorList: () => Promise<Operators>;
  commonObjs: { has: (name: string) => boolean; get: (name: string) => unknown };
  cleanup: () => void;
}

/**
 * Extract every page of a PDF into paragraphs with reading order and geometry.
 *
 * Page indices in the returned data are 0-based so they can be used directly
 * with pdf-lib. pdf.js numbers pages from 1, so the conversion happens here;
 * mixing the two conventions silently shifts every page by one.
 *
 * @param bytes - complete PDF file contents.
 * @param options - optional password and 1-based inclusive page range.
 * @returns one entry per page, in document order.
 */
export async function extractPages(
  bytes: Uint8Array,
  options: { password?: string; firstPage?: number; lastPage?: number } = {},
): Promise<PageContent[]> {
  const doc = await openDocument(bytes, options.password);
  const pages: PageContent[] = [];
  // Preferences are 1-based (`firstPage: 1` means the first page); `0` or unset
  // means "no bound".
  const first = Math.max(0, (options.firstPage ?? 1) - 1);
  const last =
    options.lastPage && options.lastPage > 0
      ? Math.min(doc.numPages - 1, options.lastPage - 1)
      : doc.numPages - 1;

  try {
    for (let index = first; index <= last; index++) {
      pages.push(await extractPage(doc, index));
    }
  } finally {
    await doc.destroy().catch((error: unknown) => {
      ztoolkit.log("pdf.js document cleanup failed", error);
    });
  }
  return pages;
}

/** Extract one page by its 0-based index. */
async function extractPage(
  doc: { getPage: (pageNumber: number) => Promise<unknown> },
  index: number,
): Promise<PageContent> {
  // pdf.js takes a 1-based page number.
  const page = (await doc.getPage(index + 1)) as PageLike;
  // getOperatorList() resolves the page's common objects, which is what makes
  // the real embedded font names reachable from resolveFontName().
  const [textContent, operatorList] = await Promise.all([
    page.getTextContent(),
    page.getOperatorList().catch((error: unknown) => {
      ztoolkit.log(`operator list unavailable on page ${index + 1}`, error);
      throw new Error(`Cannot inspect graphics on page ${index + 1}: ${String(error)}`);
    }),
  ]);

  const geometry = pageGeometry(page.view, page.rotate);
  const runs = toRuns(textContent.items, geometry, (loadedName) =>
    resolveFontName(page, loadedName),
  );
  const readOutline = mathOutlineReader(page, operatorList, pdfjsOps() ?? {});
  for (const run of runs) {
    run.isMath = isMathRun(run);
    if (run.isMath) run.outlines = readOutline(run);
  }

  const protectedRegions = graphicRegions(operatorList, pdfjsOps() ?? {}, geometry);
  protectedRegions.push(...textTableRegions(runs.filter(run => !insideGraphic(run, protectedRegions))));
  const lines = toReadingOrder(buildLines(runs.filter(run => !insideGraphic(run, protectedRegions))));
  const paragraphs = buildParagraphs(lines);
  page.cleanup();

  return {
    index,
    width: geometry.width,
    height: geometry.height,
    rotate: geometry.rotate,
    paragraphs,
    protectedRegions,
    imageCount: countImages(operatorList.fnArray),
  };
}

/** Count raster image paint operations, used for diagnostics. */
function countImages(fnArray: number[]): number {
  const ops = pdfjsOps();
  if (!ops || !fnArray.length) {
    return 0;
  }
  const targets = new Set(
    IMAGE_OP_NAMES.map((name) => ops[name]).filter(
      (value): value is number => typeof value === "number",
    ),
  );
  let count = 0;
  for (const fn of fnArray) {
    if (targets.has(fn)) {
      count++;
    }
  }
  return count;
}

/** Convert reading-ordered lines into translatable paragraphs with geometry. */
function buildParagraphs(lines: TextLine[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  const groups = toParagraphs(lines).flatMap(group => {
    const split: TextLine[][] = [];
    for (const line of group) {
      const previous = split[split.length - 1];
      if (!previous || isDisplayFormula(line) !== isDisplayFormula(previous[0])) split.push([line]);
      else previous.push(line);
    }
    return split;
  });
  for (const group of groups) {
    if (!group.length) {
      continue;
    }
    const box = unionBox(group.map(lineBox));
    const geometry = paragraphGeometry(group);

    if (group.every((line) => isDisplayFormula(line))) {
      const text = group
        .map((line) => line.text)
        .join(" ")
        .trim();
      if (text) {
        paragraphs.push({
          source: "",
          math: [{ token: "", text }],
          column: columnOf(group[0]),
          isFormulaBlock: true,
          box,
          lineBoxes: group.map(lineBox),
          ...geometry,
        });
      }
      continue;
    }

    const math: MathSpan[] = [];
    const parts: string[] = [];
    for (const line of group) {
      parts.push(extractMathPlaceholders(line, math));
    }

    const source = joinLines(parts);
    if (source.length < 2 && !math.length) {
      continue;
    }
    paragraphs.push({
      source,
      math,
      column: columnOf(group[0]),
      isFormulaBlock: false,
      box,
      lineBoxes: group.map(lineBox),
      ...geometry,
    });
  }

  return paragraphs;
}

/** Union of several boxes. */
function unionBox(boxes: Box[]): Box {
  return boxes.reduce<Box>(
    (acc, box) => ({
      left: Math.min(acc.left, box.left),
      top: Math.min(acc.top, box.top),
      right: Math.max(acc.right, box.right),
      bottom: Math.max(acc.bottom, box.bottom),
    }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
  );
}

/** Font size, leading and baseline positions of a paragraph. */
function paragraphGeometry(group: TextLine[]): {
  baselines: number[];
  fontSize: number;
  leading: number;
} {
  const sizes = group.map(lineFontSize).sort((a, b) => a - b);
  const fontSize = sizes[Math.floor(sizes.length / 2)] ?? 10;
  const baselines = group.map((line) => line.baseline).sort((a, b) => a - b);
  let leading = fontSize * 1.2;
  if (baselines.length > 1) {
    const deltas: number[] = [];
    for (let i = 1; i < baselines.length; i++) {
      const delta = baselines[i] - baselines[i - 1];
      if (delta > 0.5) {
        deltas.push(delta);
      }
    }
    if (deltas.length) {
      deltas.sort((a, b) => a - b);
      leading = deltas[Math.floor(deltas.length / 2)];
    }
  }
  return { baselines, fontSize, leading };
}

/** Column index of a paragraph: 0 for the left column, 1 for the right. */
function columnOf(line: TextLine): number {
  return line.column < 0 ? 0 : line.column;
}

/**
 * Join hard-wrapped line fragments into one paragraph.
 *
 * A space is inserted only between two fragments that would otherwise merge two
 * Latin words; Chinese and Japanese text must stay unspaced.
 */
function joinLines(parts: string[]): string {
  let text = "";
  for (const part of parts) {
    if (!part) {
      continue;
    }
    if (text) {
      const previous = text.slice(-1);
      const next = part.slice(0, 1);
      const latin =
        /[A-Za-z0-9)\]\u0370-\u03ff]/.test(previous) &&
        /[A-Za-z0-9(\[\u0370-\u03ff]/.test(next);
      if (latin) {
        text += " ";
      }
    }
    text += part;
  }
  return text.replace(/\s+/g, " ").trim();
}
