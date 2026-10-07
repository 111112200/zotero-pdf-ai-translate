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
 * @param pages - horizontal text on every requested page.
 * @returns run references belonging to margin lines repeated on at least two pages.
 */
export function repeatedMarginRuns(pages: PageRuns[]): Set<TextRun> {
  const occurrences = new Map<string, Array<{ page: number; runs: TextRun[] }>>();
  pages.forEach((page, index) => {
    for (const line of buildLines(page.runs)) {
      if (line.text.length < 5 || !(line.y + line.height < page.height * 0.08 || line.y > page.height * 0.94)) continue;
      const key = `${Math.round(page.width)}:${line.text}`;
      const entries = occurrences.get(key) ?? [];
      entries.push({ page: index, runs: line.runs });
      occurrences.set(key, entries);
    }
  });
  return new Set([...occurrences.values()]
    .filter(entries => new Set(entries.map(entry => entry.page)).size >= 2)
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
    return best[Math.floor(best.length / 2)];
  });
}
