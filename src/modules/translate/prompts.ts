/**
 * Prompts for whole-document academic translation.
 *
 * Two decisions are load-bearing:
 *  - Input and output are JSON arrays keyed by index, so a model that drops or
 *    reorders a segment can be detected and retried instead of silently
 *    leaving a paragraph in the source language.
 *  - Formulas and citations arrive as opaque tokens that must be copied
 *    verbatim. PDFMathTranslate and BabelDOC both rely on the same trick, and
 *    BabelDOC additionally tracks hallicinated placeholders, which the
 *    validator below does too.
 */

const LANG_NAMES: Record<string, string> = {
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  fr: "French",
  de: "German",
  es: "Spanish",
  ru: "Russian",
  auto: "the source language",
};

/**
 * Turn a language tag into the name models understand best.
 *
 * @param tag - BCP-47-ish tag from the preferences, e.g. `zh-CN`.
 * @returns an English language name, defaulting to the tag itself.
 */
export function languageName(tag: string): string {
  return LANG_NAMES[tag] ?? tag;
}

/**
 * Build the system prompt for one translation request.
 *
 * @param targetLang - target language tag.
 * @param extra - user-supplied additional instructions, appended verbatim.
 * @returns the system message content.
 */
export function systemPrompt(targetLang: string, extra = ""): string {
  const target = languageName(targetLang);
  const base = [
    `You are a professional academic translator. Translate the user's JSON array of numbered segments into ${target}.`,
    "",
    "Rules:",
    "1. Reply with a single JSON object of the form {\"segments\":[{\"i\":<index>,\"t\":\"<translation>\"}]}.",
    "   Include every input index exactly once, in the original order. Never merge or split segments.",
    "2. Translate meaning, not words. Use the register of a published research paper in the target language.",
    "3. Copy placeholders verbatim, character for character: tokens look like U+27E6 M12 U+27E7, plus {v1}, %s, %d and [[...]]. Never translate, reorder, renumber or drop them.",
    "4. Keep citations, author names, dataset names, model names, code identifiers, URLs, DOIs and numbers unchanged.",
    "5. Keep the original text for segments that are already in the target language, or that are pure references, code or symbols.",
    "6. Do not add explanations, notes, headings or commentary of your own.",
    "7. Preserve the leading numbering or bullet characters of a segment when present.",
  ].join("\n");
  return extra.trim() ? `${base}\n\nAdditional instructions from the user:\n${extra.trim()}` : base;
}

/** One unit of work sent to the model. */
export interface Segment {
  /** Index inside the current request, used for alignment. */
  i: number;
  /** Text with formulas replaced by placeholder tokens. */
  t: string;
}

/**
 * Render the user message for a batch of segments.
 *
 * @param segments - segments to translate.
 * @returns the user message content.
 */
export function userPrompt(segments: Segment[]): string {
  return JSON.stringify({ segments });
}

/**
 * Placeholder tokens that appear in a translated segment.
 *
 * The exact token strings matter, not just the numbers they carry: the renderer
 * looks a token up by string, so a reply that rewrites `⟦M1⟧` as `⟦M01⟧` loses
 * the formula even though it "kept placeholder 1".
 *
 * @param text - translated text.
 * @returns one entry per occurrence, in order, duplicates included.
 */
export function placeholderTokens(text: string): string[] {
  const found: string[] = [];
  const pattern = /⟦M\d+⟧/g;
  let match = pattern.exec(text);
  while (match) {
    found.push(match[0]);
    match = pattern.exec(text);
  }
  return found;
}

/**
 * Check that a model reply preserved every placeholder of its source segment.
 *
 * Compared as a multiset: a dropped, duplicated, renumbered or re-spaced token
 * all have to be re-requested, because each one either loses a formula or draws
 * placeholder text into the translated column.
 *
 * @param source - the segment text that was sent.
 * @param translated - the model's translation.
 * @returns true when the placeholder multisets match exactly.
 */
export function placeholdersIntact(source: string, translated: string): boolean {
  const before = placeholderTokens(source).sort();
  const after = placeholderTokens(translated).sort();
  if (before.length !== after.length) {
    return false;
  }
  return before.every((token, index) => token === after[index]);
}
