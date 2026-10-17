/** Shared column positions and recurring margin text across a document. */
import { buildLines, findColumnGutter } from "./layout";
import type { TextRun } from "./types";

interface PageRuns {
  width: number;
  height: number;
  runs: TextRun[];
}

/**
 * Omit recurring headers and footers while keeping their source drawings.
 *
 * A run is dropped only when the *same text* appears at the same place and size
 * on enough pages. Identity of wording alone is not enough: a repeated footnote,
 * a table header row or the same sentence opening two consecutive pages would
 * otherwise be deleted from every page, leaving an untranslated line behind in
 * the translated column.
 *
 * @param pages - horizontal text on every requested page.
 * @returns run references belonging to margin lines repeated across the document.
 */
export function repeatedMarginRuns(pages: PageRuns[]): Set<TextRun> {
  const occurrences = new Map<string, Array<{ page: number; runs: TextRun[] }>>();
  pages.forEach((page, index) => {
    for (const line of buildLines(page.runs)) {
      if (line.text.length < 5 || !(line.y + line.height < page.height * 0.08 || line.y > page.height * 0.94)) continue;
      const size = Math.max(...line.runs.map(run => run.fontSize));
      const key = `${Math.round(page.width)}:${Math.round(line.x / 4)}:${Math.round(size * 2)}:${line.text}`;
      const entries = occurrences.get(key) ?? [];
      entries.push({ page: index, runs: line.runs });
      occurrences.set(key, entries);
    }
  });
  // A running head sits on every page; requiring it on a fair share of them
  // keeps a two-page excerpt working without letting a coincidence delete text.
  const threshold = Math.max(2, Math.ceil(pages.length * 0.4));
  return new Set([...occurrences.values()]
    .filter(entries => new Set(entries.map(entry => entry.page)).size >= threshold)
    .flatMap(entries => entries.flatMap(entry => entry.runs)));
}

/**
 * Supply column positions for pages dominated by figures or sparse text.
 * @param pages - horizontal text after removing protected content and recurring margins.
 * @returns a gutter for each page, borrowing only from pages of the same width.
 */
export function documentGutters(pages: PageRuns[]): Array<number | null> {
  const local = pages.map(page => findColumnGutter(page.runs));
  return pages.map((page, index) => {
    if (local[index] !== null) return local[index];
    const evidence = pages.flatMap((other, otherIndex) => Math.abs(other.width - page.width) < 1 && local[otherIndex] !== null ? [local[otherIndex]!] : []);
    const clusters = evidence.map(value => evidence.filter(other => Math.abs(other - value) < page.width * 0.025));
    const best = clusters.sort((a, b) => b.length - a.length)[0];
    if (!best || best.length < 2) return null;
    best.sort((a, b) => a - b);
    const gutter = best[Math.floor(best.length / 2)];
    // Borrowing is only sound when this page's own text sits on both sides of
    // the borrowed gutter. Otherwise a single-column page inherits a two-column
    // layout from its neighbours: every line is reassigned to the right column
    // and any line with a wide internal gap at that x is split in two, so the
    // fragments get translated into boxes of their own.
    return hasColumnEvidence(page.runs, gutter) ? gutter : null;
  });
}

/**
 * True when runs really do form two columns around `gutter`.
 *
 * @param runs - the page's horizontal text.
 * @param gutter - the borrowed gutter position.
 * @returns true when enough runs sit wholly on each side and few cross it.
 */
function hasColumnEvidence(runs: TextRun[], gutter: number): boolean {
  let left = 0;
  let right = 0;
  let crossing = 0;
  for (const run of runs) {
    if (run.x + run.width <= gutter) left++;
    else if (run.x >= gutter) right++;
    else crossing++;
  }
  if (left < 3 || right < 3) return false;
  return crossing <= Math.max(2, (left + right) * 0.25);
}
