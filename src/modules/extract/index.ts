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
import { documentGutters, repeatedMarginRuns } from "./documentLayout";
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
import type { Box, MathSpan, PageContent, Paragraph, TextLine, TextRun } from "./types";

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

interface RawPage extends Omit<PageContent, "paragraphs"> {
  runs: TextRun[];
  readOutline: ReturnType<typeof mathOutlineReader>;
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
    const raw: RawPage[] = [];
    for (let index = first; index <= last; index++) {
      raw.push(await extractPage(doc, index));
    }
    const margins = repeatedMarginRuns(raw);
    for (const page of raw) page.runs = page.runs.filter(run => !margins.has(run));
    const gutters = documentGutters(raw);
    for (const [position, page] of raw.entries()) {
      const lines = toReadingOrder(buildLines(page.runs, gutters[position]));
      for (const line of lines) {
        for (const run of line.runs) {
          if (run.fontSize < lineFontSize(line) * 0.85 && /^[*\d]+$/.test(run.text)) run.isMath = true;
          // Formula groups also use original glyphs for their roman operators and indices.
          if (run.isMath || run.fontSize < lineFontSize(line) * 0.85 || /^[\d\W]+$/u.test(run.text) || /^(?:true|Kalman|log|exp|max|min)$/.test(run.text)) {
            run.outlines = page.readOutline(run);
          }
        }
      }
      const paragraphs = buildParagraphs(lines);
      pages.push({ index: page.index, width: page.width, height: page.height, rotate: page.rotate, protectedRegions: [...page.protectedRegions ?? [], ...paragraphs.filter(paragraph => paragraph.isFormulaBlock).map(paragraph => paragraph.box)], imageCount: page.imageCount, paragraphs });
      page.cleanup();
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
): Promise<RawPage> {
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
  }

  const protectedRegions = graphicRegions(operatorList, pdfjsOps() ?? {}, geometry, runs);
  protectedRegions.push(...textTableRegions(runs.filter(run => !insideGraphic(run, protectedRegions))));
  return {
    index,
    width: geometry.width,
    height: geometry.height,
    rotate: geometry.rotate,
    runs: runs.filter(run => !insideGraphic(run, protectedRegions)),
    readOutline,
    cleanup: () => page.cleanup(),
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
  const formulas = new Set(lines.filter(isDisplayFormula));
  for (const line of lines) {
    if (formulas.has(line) || (line.text.match(/[A-Za-z]{3,}/g)?.length ?? 0) > 1) continue;
    if ([...formulas].some(formula => formula.column === line.column && line.x >= formula.x - 2 && line.x + line.width <= formula.x + formula.width + 2 && line.y < formula.y + formula.height + lineFontSize(formula) * 0.6 && line.y + line.height > formula.y - lineFontSize(formula) * 0.6)) formulas.add(line);
  }

  const groups = toParagraphs(lines).flatMap(group => {
    const split: TextLine[][] = [];
    for (const line of group) {
      const previous = split[split.length - 1];
      if (!previous || formulas.has(line) !== formulas.has(previous[0])) split.push([line]);
      else previous.push(line);
    }
    return split;
  });
  for (const group of groups) {
    if (!group.length) {
      continue;
    }
    const box = unionBox(group.map(lineBox));
    const geometry = paragraphGeometry(group, lines);

    if (group.every(line => formulas.has(line))) {
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
function paragraphGeometry(group: TextLine[], allLines: TextLine[]): {
  baselines: number[];
  fontSize: number;
  leading: number;
  bold: boolean;
  alignment: "left" | "center";
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
  const principal = group.flatMap(line => line.runs).filter(run => run.fontSize >= fontSize * 0.85);
  const boldChars = principal.filter(run => /Bold|Medi|Demi|CMBX|Semibold/i.test(run.fontName)).reduce((sum, run) => sum + run.text.length, 0);
  const bold = boldChars > principal.reduce((sum, run) => sum + run.text.length, 0) * 0.6;
  const peers = allLines.filter(line => line.column === group[0].column && line.runs.some(run => !run.isMath));
  const left = Math.min(...peers.map(line => line.x)), right = Math.max(...peers.map(line => line.x + line.width));
  const center = (left + right) / 2;
  const centers = group.map(line => line.x + line.width / 2);
  const centeredTitle = group.length > 1 && bold && Math.max(...centers) - Math.min(...centers) < fontSize * 0.25 && Math.max(...group.map(line => line.x)) - Math.min(...group.map(line => line.x)) > fontSize * 0.65;
  const centered = (group[0].column === -1 && bold) || centeredTitle || (bold && group.every(line => Math.abs(line.x + line.width / 2 - center) < fontSize && line.x > left + fontSize * 2));
  return { baselines, fontSize, leading, bold, alignment: centered ? "center" : "left" };
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
