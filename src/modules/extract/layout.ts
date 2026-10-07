/**
 * Turn pdf.js text items into lines, reading order and paragraph geometry.
 *
 * Two jobs have to happen in the right order here:
 *
 *  1. **Column separation.** Grouping runs by baseline alone merges the left and
 *     right columns of a two-column paper into single lines that span the page,
 *     which then produces paragraph boxes covering both columns. Since the
 *     renderer draws each translation back into its paragraph's box, that would
 *     destroy the column structure instead of preserving it. Lines are therefore
 *     split wherever a wide horizontal gap sits in the middle of the text block,
 *     which is what a gutter is.
 *
 *  2. **Reading order.** pdf.js returns items in content-stream order, which
 *     interleaves columns, so the order has to be rebuilt band by band.
 */

import type { PageGeometry } from "./geometry";
import type { Box, TextLine, TextRun } from "./types";

/** Vertical tolerance for treating two runs as sharing a baseline. */
const BASELINE_TOLERANCE = 0.55;
/** Ratio of font size used for a line's ink height. */
const LINE_HEIGHT_RATIO = 1.18;
/** Minimum horizontal gap, in ems, that separates two columns. */
const COLUMN_GAP_EMS = 1.2;
/** Absolute floor for the column gap, in points. */
const COLUMN_GAP_MIN_PT = 8;
/** A gap counts as a column break only inside this share of the text block. */

/**
 * Normalize pdf.js text items into page-space runs.
 *
 * @param items - `textContent.items` from a pdf.js page.
 * @param geometry - page size and rotation, used to place each run the way the
 *   reader sees it.
 * @param resolveFont - maps a pdf.js loaded font name to the embedded name.
 * @returns runs in the order pdf.js produced them.
 */
export function toRuns(
  items: Array<{
    str: string;
    width?: number;
    height?: number;
    transform?: number[];
    fontName?: string;
  }>,
  geometry: PageGeometry,
  resolveFont: (loadedName: string | undefined) => string,
): TextRun[] {
  const runs: TextRun[] = [];
  for (const item of items) {
    const text = item.str;
    if (!text || !text.trim()) {
      // Whitespace-only items carry no glyphs; runs are joined with spaces
      // based on their measured gaps instead.
      continue;
    }
    const t = item.transform ?? [1, 0, 0, 1, 0, 0];
    const fontSize = Math.hypot(t[2], t[3]) || Math.abs(t[3]) || 10;
    const advance = typeof item.width === "number" ? item.width : 0;
    // `transform` is in PDF user space and does not include `/Rotate`, so the
    // baseline is rotated into display space together with the advance vector.
    const axis = Math.hypot(t[0], t[1]) || 1;
    const start = geometry.toNormalized(t[4], t[5]);
    const direction = geometry.toNormalized(t[4] + t[0] / axis, t[5] + t[1] / axis);
    // Rotated margin labels keep their source drawing and never enter horizontal prose.
    if (direction.x <= start.x || Math.abs(direction.y - start.y) > Math.abs(direction.x - start.x) * 0.15) {
      continue;
    }
    const end = geometry.toNormalized(
      t[4] + (t[0] / axis) * advance,
      t[5] + (t[1] / axis) * advance,
    );
    const height = Math.max(Math.abs(end.y - start.y), fontSize * LINE_HEIGHT_RATIO);
    runs.push({
      text,
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y) - (height - Math.abs(end.y - start.y)) * 0.88 / LINE_HEIGHT_RATIO,
      width: Math.abs(end.x - start.x),
      height,
      fontName: resolveFont(item.fontName),
      fontId: item.fontName,
      fontSize,
      baseline: start.y,
    });
  }
  return runs;
}

/** Compute the union bounding box of a run list. */
export function boundsOf(runs: TextRun[]): Box {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const run of runs) {
    left = Math.min(left, run.x);
    right = Math.max(right, run.x + run.width);
    top = Math.min(top, run.y);
    bottom = Math.max(bottom, run.y + run.height);
  }
  return { left, right, top, bottom };
}

/** Largest font size among a line's runs, used as its nominal text size. */
export function lineFontSize(line: TextLine): number {
  let size = 0;
  for (const run of line.runs) {
    size = Math.max(size, run.fontSize);
  }
  return size || 10;
}

/** Convert a line to its bounding box. */
export function lineBox(line: TextLine): Box {
  return {
    left: line.x,
    top: line.y,
    right: line.x + line.width,
    bottom: line.y + line.height,
  };
}

/** Assemble a `TextLine` from runs that belong together. */
function makeLine(runs: TextRun[], column: number): TextLine {
  runs.sort((a, b) => a.x - b.x);
  const box = boundsOf(runs);
  const principal = [...runs].sort((a, b) => b.fontSize - a.fontSize || b.text.length - a.text.length)[0];
  const baseline = principal.baseline ?? principal.y + principal.fontSize * 0.88;
  return {
    runs,
    x: box.left,
    y: box.top,
    width: box.right - box.left,
    height: box.bottom - box.top,
    baseline,
    column,
    text: joinRuns(runs),
  };
}

/**
 * Build the visual lines of a page, splitting each baseline group at the
 * column gutter.
 *
 * Two passes are needed. Grouping by baseline alone merges the left and right
 * columns of a two-column paper into lines that span the page, so the gutter has
 * to be found before lines can be assigned to a column. A line that merely has
 * no counterpart on the other side is *not* spanning — only a line whose ink
 * crosses the gutter is — and getting that distinction wrong collapses the
 * reading order, because spanning lines delimit reading regions.
 *
 * @param runs - runs on one page.
 * @param fallbackGutter - column position inferred from other pages of the document.
 * @returns lines in top-to-bottom order, each tagged with its column.
 */
export function buildLines(runs: TextRun[], fallbackGutter?: number | null): TextLine[] {
  if (!runs.length) {
    return [];
  }
  const raw = groupByBaseline(runs);
  const gutter = findGutter(raw) ?? gutterFromAlignedStarts(runs) ?? fallbackGutter ?? null;
  lastGutter = gutter;

  const lines: TextLine[] = [];
  for (const line of raw) {
    lines.push(...assignColumn(line, gutter));
  }
  const attached = new Set<TextLine>();
  for (const line of lines) {
    if (attached.has(line) || line.text.length > 16) continue;
    const size = lineFontSize(line);
    const candidates = lines.filter(other => other !== line && !attached.has(other) && other.column === line.column && lineFontSize(other) > size / 0.85 && Math.abs(other.baseline - line.baseline) < lineFontSize(other) * 0.8 && other.x <= line.x + line.width + 2 && other.x + other.width >= line.x - 2);
    candidates.sort((a, b) => Math.abs(a.baseline - line.baseline) - Math.abs(b.baseline - line.baseline));
    const target = candidates[0];
    if (target) {
      Object.assign(target, makeLine([...target.runs, ...line.runs], target.column));
      attached.add(line);
    }
  }
  return lines.filter(line => !attached.has(line)).sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Gutter detected for the most recent `buildLines` call; diagnostics only. */
export let lastGutter: number | null = null;

/** Group runs into unsplit lines by baseline proximity. */
function groupByBaseline(runs: TextRun[]): TextLine[] {
  const buckets: Array<{ baseline: number; size: number; runs: TextRun[] }> = [];
  // Principal glyphs establish baselines before their smaller attached scripts.
  const sorted = [...runs].sort((a, b) => b.fontSize - a.fontSize || b.text.length - a.text.length);
  for (const run of sorted) {
    const baseline = run.baseline ?? run.y + run.fontSize * 0.88;
    const candidates = buckets.filter(bucket => Math.abs(bucket.baseline - baseline) <= BASELINE_TOLERANCE * bucket.size);
    candidates.sort((a, b) => Math.abs(a.baseline - baseline) - Math.abs(b.baseline - baseline));
    const bucket = candidates[0];
    if (bucket) bucket.runs.push(run);
    else buckets.push({ baseline, size: run.fontSize, runs: [run] });
  }
  return buckets.map(bucket => makeLine(bucket.runs, -2)).sort((a, b) => a.y - b.y);
}

/**
 * Locate a column gutter when this page has enough paired text lines.
 * @param runs - horizontal text outside figures and tables.
 * @returns the gutter centre, or null when this page alone supplies insufficient evidence.
 */
export function findColumnGutter(runs: TextRun[]): number | null {
  return findGutter(groupByBaseline(runs)) ?? gutterFromAlignedStarts(runs);
}

/** Infer sparse columns from repeated left edges with a shared empty gutter. */
function gutterFromAlignedStarts(runs: TextRun[]): number | null {
  if (!runs.length) return null;
  const block = boundsOf(runs), width = block.right - block.left;
  if (width < 240) return null;
  const candidates = runs.filter(run => run.width > width * 0.2 && run.width < width * 0.6 && run.text.length > 12);
  const clusters: TextRun[][] = [];
  for (const run of candidates.sort((a, b) => a.x - b.x)) {
    const cluster = clusters[clusters.length - 1];
    if (cluster && run.x - cluster[0].x < 4) cluster.push(run);
    else clusters.push([run]);
  }
  const repeated = clusters.filter(cluster => cluster.length >= 4);
  for (const left of [...repeated].sort((a, b) => b.length - a.length)) {
    const right = repeated.filter(cluster => cluster[0].x - left[0].x > width * 0.35).sort((a, b) => b.length - a.length)[0];
    if (!right) continue;
    const ends = left.map(run => run.x + run.width).sort((a, b) => a - b);
    const edge = ends[Math.floor(ends.length * 0.8)];
    if (right[0].x - edge >= COLUMN_GAP_MIN_PT) return (right[0].x + edge) / 2;
  }
  return null;
}

/**
 * Locate the vertical gutter that separates two text columns.
 *
 * Rather than scanning for an empty band — which fails on pages that mix
 * full-width headings, a single-column abstract and a figure with a two-column
 * body — this collects the widest internal gap of every line and takes the
 * consensus. The position where most lines break in the middle *is* the gutter,
 * and lines that do not break there simply do not vote.
 *
 * @param lines - unsplit baseline groups.
 * @returns the gutter centre in points, or `null` for a single-column page.
 */
function findGutter(lines: TextLine[]): number | null {
  if (lines.length < 8) {
    return null;
  }
  const block = boundsOf(lines.flatMap((line) => line.runs));
  const textWidth = block.right - block.left;
  if (textWidth < 120) {
    return null;
  }
  const low = block.left + textWidth * 0.25;
  const high = block.left + textWidth * 0.75;

  const votes: number[] = [];
  for (const line of lines) {
    const centre = widestInternalGap(line, low, high);
    if (centre !== null) {
      votes.push(centre);
    }
  }
  if (votes.length < Math.max(6, lines.length * 0.25)) {
    return null;
  }

  // Cluster the votes and keep the largest cluster. ±36pt covers the spread
  // caused by lines whose last word is unusually short or long.
  votes.sort((a, b) => a - b);
  let bestStart = 0;
  let bestCount = 0;
  let start = 0;
  for (let i = 1; i <= votes.length; i++) {
    if (i < votes.length && votes[i] - votes[start] <= 36) {
      continue;
    }
    if (i - start > bestCount) {
      bestCount = i - start;
      bestStart = start;
    }
    start = i;
  }
  if (bestCount < 6) {
    return null;
  }
  const cluster = votes.slice(bestStart, bestStart + bestCount);
  return cluster[Math.floor(cluster.length / 2)];
}

/**
 * Centre of a line's widest internal gap, when that gap is wide enough to be a
 * column break and lies inside `[low, high]`.
 *
 * @param line - an unsplit baseline group.
 * @param low - left bound for a plausible gutter.
 * @param high - right bound for a plausible gutter.
 * @returns the gap centre, or `null` when the line has no such gap.
 */
function widestInternalGap(
  line: TextLine,
  low: number,
  high: number,
): number | null {
  const ordered = [...line.runs].sort((a, b) => a.x - b.x);
  if (ordered.length < 2) {
    return null;
  }
  const largest = Math.max(...ordered.map((run) => run.fontSize));
  const threshold = Math.max(COLUMN_GAP_MIN_PT, largest * COLUMN_GAP_EMS);
  let best: number | null = null;
  let bestGap = 0;
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1];
    const gap = ordered[i].x - (previous.x + previous.width);
    if (gap < threshold || gap <= bestGap) {
      continue;
    }
    const centre = previous.x + previous.width + gap / 2;
    if (centre >= low && centre <= high) {
      best = centre;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * Decide which column a line belongs to, splitting it when its ink crosses the
 * gutter with a real gap in it.
 *
 * The test is positional rather than heuristic: if some run covers the gutter,
 * the ink really does run across the page and the line spans the whole text
 * block (a title, a wide table row). Otherwise the gutter falls inside a gap
 * between two runs, which means the baseline group is two column lines that
 * pdf.js happened to return together, and it is split there.
 *
 * An earlier version split at the widest gap near the gutter. That misfired on
 * figure labels and short last lines, and an unsplit line becomes a full-width
 * paragraph, which the renderer then uses as a drawing box — so the translation
 * is laid out across both columns and collides with them.
 *
 * @param line - an unsplit baseline group.
 * @param gutter - gutter centre, or `null` on a single-column page.
 * @returns one line per column segment.
 */
function assignColumn(line: TextLine, gutter: number | null): TextLine[] {
  if (gutter === null) {
    return [{ ...line, column: 0 }];
  }
  const left = line.x;
  const right = line.x + line.width;
  if (right <= gutter) {
    return [{ ...line, column: 0 }];
  }
  if (left >= gutter) {
    return [{ ...line, column: 1 }];
  }

  const ordered = [...line.runs].sort((a, b) => a.x - b.x);
  const largest = Math.max(...ordered.map((run) => run.fontSize));
  const threshold = Math.max(COLUMN_GAP_MIN_PT, largest * COLUMN_GAP_EMS);

  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1];
    const previousEnd = previous.x + previous.width;
    const nextStart = ordered[i].x;
    if (previousEnd > gutter || nextStart < gutter) {
      continue; // the gutter is not inside this gap
    }
    if (nextStart - previousEnd < threshold) {
      break; // the gutter sits inside ordinary word spacing
    }
    return [makeLine(ordered.slice(0, i), 0), makeLine(ordered.slice(i), 1)];
  }
  return [{ ...line, column: -1 }];
}

/** Join runs into one string, inserting a space where pdf.js dropped one. */
function joinRuns(runs: TextRun[]): string {
  let text = "";
  let previous: TextRun | undefined;
  for (const run of runs) {
    if (previous) {
      const gap = run.x - (previous.x + previous.width);
      const spaceWidth = Math.max(1, run.fontSize * 0.22);
      if (gap > spaceWidth && !/\s$/.test(text) && !/^\s/.test(run.text)) {
        text += " ";
      }
    }
    text += run.text;
    previous = run;
  }
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Order lines the way a human reads them.
 *
 * Lines tagged `-1` span the whole text block, so they separate reading regions;
 * within a region the left column is read before the right one.
 *
 * @param lines - visual lines on one page.
 * @returns lines in reading order.
 */
export function toReadingOrder(lines: TextLine[]): TextLine[] {
  if (!lines.length) {
    return [];
  }
  const sorted = [...lines].sort((a, b) => a.y - b.y || a.x - b.x);
  const ordered: TextLine[] = [];
  let band: TextLine[] = [];

  const flush = () => {
    if (!band.length) {
      return;
    }
    const left = band.filter((line) => line.column <= 0).sort((a, b) => a.y - b.y);
    const right = band.filter((line) => line.column > 0).sort((a, b) => a.y - b.y);
    ordered.push(...left, ...right);
    band = [];
  };

  for (const line of sorted) {
    if (line.column < 0) {
      flush();
      ordered.push(line);
    } else {
      band.push(line);
    }
  }
  flush();
  return ordered;
}

/**
 * Estimate the right edge of each line's text column.
 *
 * Lines sharing a left edge and a column belong together; the rightmost extent
 * among them approximates the column edge, which decides whether a line is the
 * short last line of a paragraph.
 *
 * @param lines - lines on one page, in reading order.
 * @returns the column right edge for each line, in the same order.
 */
function columnEdges(lines: TextLine[]): number[] {
  const ALIGN_TOLERANCE = 14;
  return lines.map((line) => {
    let right = line.x + line.width;
    for (const other of lines) {
      if (
        other.column === line.column &&
        Math.abs(other.x - line.x) <= ALIGN_TOLERANCE
      ) {
        right = Math.max(right, other.x + other.width);
      }
    }
    return right;
  });
}

/**
 * Merge consecutive lines into paragraphs.
 *
 * A new paragraph starts when the column changes, when the previous line ends
 * well short of its column edge, when the vertical gap exceeds the normal
 * leading, or when the line is indented relative to the previous one.
 *
 * @param lines - lines already in reading order.
 * @returns paragraphs, each a list of lines.
 */
export function toParagraphs(lines: TextLine[]): TextLine[][] {
  const paragraphs: TextLine[][] = [];
  const edges = columnEdges(lines);
  let current: TextLine[] = [];
  let previousIndex = -1;
  const spacing = lines.flatMap((line, index) => {
    const previous = lines[index - 1];
    if (!previous || previous.column !== line.column) return [];
    const size = Math.max(lineFontSize(previous), lineFontSize(line));
    const ratio = (line.baseline - previous.baseline) / size;
    return ratio > 0.85 && ratio < 1.7 ? [ratio] : [];
  }).sort((a, b) => a - b);
  const usualLeadingRatio = spacing[Math.floor(spacing.length / 2)] ?? 1.2;

  const flush = () => {
    if (current.length) {
      paragraphs.push(current);
      current = [];
    }
  };

  lines.forEach((line, index) => {
    if (previousIndex >= 0) {
      const previous = lines[previousIndex];
      const edge = edges[previousIndex];
      const columnWidth = Math.max(edge - previous.x, 1);
      const gap = line.y - (previous.y + previous.height);
      const leading = Math.max(lineFontSize(previous), lineFontSize(line));
      const shortLine = previous.width < columnWidth * 0.82;
      const previousSize = lineFontSize(previous);
      const nextSize = lineFontSize(line);
      const centeredPair = previous.runs.some(run => /Bold|Medi|Demi|CMBX|Semibold/i.test(run.fontName)) && line.runs.some(run => /Bold|Medi|Demi|CMBX|Semibold/i.test(run.fontName)) && Math.abs(previous.x + previous.width / 2 - line.x - line.width / 2) < leading * 0.25;
      if (
        line.column !== previous.column ||
        Math.abs(nextSize - previousSize) > leading * 0.15 ||
        /^\s*[•●]/.test(line.text) ||
        (line.column >= 0 && !centeredPair && line.x > previous.x + leading * 0.65 && line.x < previous.x + leading * 3 && !/^\s*[•●]/.test(previous.text)) ||
        line.baseline - previous.baseline > leading * usualLeadingRatio * 1.3 ||
        gap > leading * 0.65 ||
        (shortLine && !centeredPair) ||
        (!centeredPair && line.x > previous.x + Math.max(12, leading))
      ) {
        flush();
      }
    }
    current.push(line);
    previousIndex = index;
  });
  flush();
  return paragraphs;
}
