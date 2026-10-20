/**
 * Per-paragraph quality audit.
 *
 * The batch contract already catches a segment the model dropped and a formula
 * placeholder it mangled. What it cannot see is a reply that came back
 * complete-looking but defective: the translation stops halfway through the
 * paragraph, loses its closing bracket, or never switched language at all even
 * though it is not byte-identical to the source. Those are the defects readers
 * report, and they are all cheap to detect from the text alone — a translation
 * of a paragraph cannot shed two thirds of its length, cannot end mid-sentence,
 * and cannot leave its own brackets open.
 *
 * A flagged paragraph is re-requested once with the problem named. A paragraph
 * that is still flagged after that is kept, not discarded: a slightly short
 * translation serves a reader better than an English paragraph in the middle of
 * a Chinese page.
 */

/** What the audit can complain about. */
export type QualityIssueCode =
  | "empty"
  | "not-translated"
  | "truncated"
  | "overlong"
  | "unbalanced"
  | "unterminated";

export interface QualityIssue {
  code: QualityIssueCode;
  /** One short sentence, used both for reporting and as the retry instruction. */
  hint: string;
}

/** Target languages written without Latin letters, where the length rules apply. */
const CJK_TARGET = /^(zh|ja|ko)(-|$)/i;
/** Characters that prove a translation actually switched script. */
const CJK_TEXT = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/;
/** Brackets whose opening and closing counts must match inside one reply. */
const BRACKET_PAIRS: Array<[string, string]> = [
  ["（", "）"],
  ["(", ")"],
  ["【", "】"],
  ["[", "]"],
  ["《", "》"],
  ["「", "」"],
  ["『", "』"],
];
/** Endings that mean "this sentence is finished". */
const TERMINAL = /[.。．!！?？…:：;；,，、)）】》」』"”'’]$/;
/** Source endings that promise the translation will end too. */
const SOURCE_TERMINAL = /[.。！!？?]$/;
/** Below this share of the source length a CJK translation has lost content. */
const MIN_LENGTH_RATIO = 0.25;
/** Above this share the model repeated or padded the paragraph. */
const MAX_LENGTH_RATIO = 2.5;
/** Paragraphs shorter than this are too noisy to judge by length or ending. */
const MIN_JUDGED_LENGTH = 40;
/** Latin words a paragraph needs before "no CJK at all" is suspicious. */
const MIN_WORDS_FOR_TRANSLATION = 15;

/** True when the target language is expected to use CJK characters. */
export function isCjkTarget(targetLang: string): boolean {
  return CJK_TARGET.test(targetLang.trim());
}

/** Count of Latin-looking words, used to tell prose from labels. */
function latinWords(text: string): number {
  return text.match(/[A-Za-z][A-Za-z'’-]*/g)?.length ?? 0;
}

/** Signs that a bracket in the reply was opened and never closed. */
function unbalancedBrackets(text: string): string | undefined {
  for (const [open, close] of BRACKET_PAIRS) {
    const opened = [...text].filter((ch) => ch === open).length;
    const closed = [...text].filter((ch) => ch === close).length;
    if (opened !== closed) {
      return `Brackets do not match: "${open}" opened ${opened} time(s), "${close}" closed ${closed} time(s)`;
    }
  }
  return undefined;
}

/**
 * Judge one translated paragraph against its source.
 *
 * @param source - the text that was sent, placeholders included.
 * @param translated - what came back.
 * @param targetLang - target language tag, which selects the length and script rules.
 * @returns every problem found, empty when the reply looks sound.
 */
export function auditTranslation(
  source: string,
  translated: string,
  targetLang: string,
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const text = translated.trim();
  if (!text) {
    return [{ code: "empty", hint: "The previous reply for this segment was empty. Translate the whole segment." }];
  }

  const cjkTarget = isCjkTarget(targetLang);
  const sourceText = source.trim();

  if (
    cjkTarget &&
    !CJK_TEXT.test(text) &&
    latinWords(sourceText) >= MIN_WORDS_FOR_TRANSLATION
  ) {
    issues.push({
      code: "not-translated",
      hint: "The previous reply was still in the source language. Translate it into the target language.",
    });
  }

  if (cjkTarget && sourceText.length >= MIN_JUDGED_LENGTH) {
    const ratio = [...text].length / Math.max(1, [...sourceText].length);
    if (ratio < MIN_LENGTH_RATIO) {
      issues.push({
        code: "truncated",
        hint: "The previous translation stopped early. Translate the entire segment, not just the first part.",
      });
    } else if (ratio > MAX_LENGTH_RATIO) {
      issues.push({
        code: "overlong",
        hint: "The previous translation was much longer than the source, which usually means repeated or added content. Translate it faithfully and concisely.",
      });
    }
  }

  const bracket = unbalancedBrackets(text);
  if (bracket) {
    issues.push({ code: "unbalanced", hint: `${bracket}. Close every bracket you open.` });
  }

  if (
    [...sourceText].length >= MIN_JUDGED_LENGTH &&
    SOURCE_TERMINAL.test(sourceText) &&
    !TERMINAL.test(text)
  ) {
    issues.push({
      code: "unterminated",
      hint: "The previous translation stopped mid-sentence. Finish the sentence and keep its closing punctuation.",
    });
  }

  return issues;
}

/**
 * Merge the reasons of several flagged paragraphs into one instruction.
 *
 * @param issues - every issue collected for a correction request.
 * @returns deduplicated sentences, ready to append to the system prompt.
 */
export function correctionHints(issues: QualityIssue[]): string[] {
  return [...new Set(issues.map((issue) => issue.hint))];
}
