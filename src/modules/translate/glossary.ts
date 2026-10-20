/**
 * Terminology list.
 *
 * A whole-paper translation is only as good as its consistency: the same term
 * translated three ways in one paper reads like three authors. The list is a
 * plain `source,target` text (a pasted CSV works), and only the entries that a
 * batch actually contains are sent — a 300-term glossary would otherwise cost
 * more tokens than the paragraphs it governs.
 *
 * Nothing is enforced after the reply. Forcing a term back in by string
 * replacement mangles morphology ("行缓冲区的" is not always the spelling), and
 * the model follows an explicit list well enough that enforcement buys little.
 */

export interface GlossaryEntry {
  /** Term as it appears in the source, e.g. `row buffer`. */
  source: string;
  /** Required rendering, e.g. `行缓冲区`. */
  target: string;
}

/** Entries longer than either limit only make prompts harder to follow. */
const MAX_ENTRIES = 500;

/**
 * Parse the glossary text the user edits in the settings pane.
 *
 * Accepted shapes, one entry per line:
 *
 * ```
 * row buffer,行缓冲区
 * DRAM	动态随机存取存储器
 * # a comment line is ignored
 * ```
 *
 * @param text - raw textarea contents.
 * @returns the usable entries, in input order, duplicates dropped.
 */
export function parseGlossary(text: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  const seen = new Set<string>();
  for (const line of (text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.includes("\t") ? "\t" : ",";
    const index = trimmed.indexOf(separator);
    if (index <= 0) {
      continue;
    }
    const source = trimmed.slice(0, index).trim();
    const target = trimmed.slice(index + 1).trim();
    if (!source || !target) {
      continue;
    }
    const key = source.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push({ source, target });
    if (entries.length >= MAX_ENTRIES) {
      break;
    }
  }
  return entries;
}

/**
 * Stable signature of the list, for cache and resume keys.
 *
 * A glossary change changes the answer, so a run started with one list must not
 * be resumed with another.
 *
 * @param entries - parsed glossary.
 * @returns a short string that is equal for equal lists.
 */
export function glossarySignature(entries: GlossaryEntry[]): string {
  return entries.map((entry) => `${entry.source}=>${entry.target}`).join("\u001f");
}

/** True when `term` occurs in `text` as a whole word (Latin) or literal run (CJK). */
function containsTerm(term: string, text: string): boolean {
  if (!term) {
    return false;
  }
  if (/^[\x20-\x7e]+$/.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i").test(text);
  }
  return text.includes(term);
}

/**
 * Build the terminology block for one batch.
 *
 * @param entries - full glossary.
 * @param text - all source segments of the batch, joined.
 * @param limit - maximum number of terms to send.
 * @returns a prompt block, or an empty string when no term applies.
 */
export function glossaryBlock(
  entries: GlossaryEntry[],
  text: string,
  limit = 40,
): string {
  const matched = entries.filter((entry) => containsTerm(entry.source, text)).slice(0, limit);
  if (!matched.length) {
    return "";
  }
  return [
    "Terminology. Render these source terms exactly as the given translation, in every segment where they occur:",
    ...matched.map((entry) => `- ${entry.source} → ${entry.target}`),
  ].join("\n");
}

/** Entries of `entries` that `text` actually contains, for reporting and tests. */
export function glossaryMatches(entries: GlossaryEntry[], text: string): GlossaryEntry[] {
  return entries.filter((entry) => containsTerm(entry.source, text));
}
