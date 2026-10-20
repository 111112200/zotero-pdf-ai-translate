/**
 * Batch translation pipeline.
 *
 * Segments are grouped into requests sized by character count, sent with a
 * bounded number of concurrent requests, and validated on the way back. A model
 * that drops, duplicates or renumbers a segment is detected and only the
 * affected segments are re-requested, so a failure never silently leaves a
 * paragraph in the source language.
 */

import { getPref } from "../../utils/prefs";
import type { ProviderProfile } from "../../utils/prefs";
import { complete, ApiError } from "./client";
import { placeholdersIntact, systemPrompt, userPrompt } from "./prompts";
import type { Segment } from "./prompts";
import { TranslationCache } from "./cache";
import { glossaryBlock, type GlossaryEntry } from "./glossary";
import { auditTranslation, correctionHints, type QualityIssue } from "./quality";
import type { TranslationRunStore } from "./resume";

/** One paragraph queued for translation. */
export interface TranslationUnit {
  /** Index of the source page the paragraph belongs to. */
  pageIndex: number;
  /** Index of the paragraph within its page. */
  paragraphIndex: number;
  /** Text with formula placeholders substituted. */
  source: string;
  /** Number of placeholders the translation must preserve. */
  mathCount: number;
}

/** What the caller gets back for each unit. */
export interface TranslationResult {
  pageIndex: number;
  paragraphIndex: number;
  translated: string;
  /** True when this unit fell back to its source text. */
  failed: boolean;
  /**
   * Set when the quality audit had something to say about this paragraph:
   * `retried` means a second reply replaced the first, `suspect` means the
   * second reply still looks wrong but was kept anyway.
   */
  quality?: "retried" | "suspect";
}

export interface ProgressReport {
  /** Units translated so far. */
  done: number;
  /** Total units in this run. */
  total: number;
  /** Free-form stage label for the progress window. */
  stage: string;
  /** Token usage accumulated so far. */
  tokens: number;
}

export interface TranslateOptions {
  profile: ProviderProfile;
  targetLang: string;
  sourceLang: string;
  systemPromptExtra: string;
  onProgress?: (report: ProgressReport) => void;
  signal?: AbortSignal;
  /**
   * Called once per batch that finished without a single usable segment, with
   * the reason it gave up.
   *
   * A run where every batch fails still returns one result per unit, all marked
   * `failed`, so the caller sees a complete-looking result set. Without this
   * callback the only trace of a dead endpoint or a rejected API key is a count
   * of untranslated paragraphs, and the export goes ahead and writes the
   * original page twice.
   */
  onBatchFailure?: (message: string) => void;
  /**
   * Where finished segments are persisted between batches, so a cancelled or
   * crashed run can be continued instead of paid for twice.
   */
  resume?: TranslationRunStore;
  /**
   * Terminology to honour. Only the entries a batch actually contains are sent,
   * so a long list costs nothing on the segments that never mention them.
   */
  glossary?: GlossaryEntry[];
  /**
   * Re-request a paragraph whose reply looks truncated or was never translated.
   * On by default: the audit is pure text comparison and costs one extra request
   * per damaged segment, not per document.
   */
  qualityAudit?: boolean;
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Split units into requests whose combined source length stays under `budget`. */
function makeBatches(units: TranslationUnit[], budget: number): TranslationUnit[][] {
  const batches: TranslationUnit[][] = [];
  let current: TranslationUnit[] = [];
  let size = 0;
  for (const unit of units) {
    const cost = unit.source.length + 24;
    if (current.length && size + cost > budget) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(unit);
    size += cost;
  }
  if (current.length) {
    batches.push(current);
  }
  return batches;
}

/** Parse a `{"segments":[{"i":n,"t":"..."}]}` reply into an index map. */
function parseSegments(raw: string): Map<number, string> {
  const text = stripCodeFence(raw);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("The reply was not valid JSON.");
  }
  const list = Array.isArray(payload)
    ? payload
    : ((payload as { segments?: unknown[] })?.segments ?? []);
  const map = new Map<number, string>();
  if (!Array.isArray(list)) {
    throw new Error("The reply did not contain a segments array.");
  }
  for (const entry of list) {
    const item = entry as { i?: unknown; t?: unknown; index?: unknown; text?: unknown };
    const index = Number(item.i ?? item.index);
    const value = item.t ?? item.text;
    if (Number.isInteger(index) && typeof value === "string") {
      map.set(index, value);
    }
  }
  return map;
}

/** Models sometimes wrap JSON in a markdown fence despite instructions. */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  return trimmed
    .replace(/^```[a-zA-Z]*\s*/, "")
    .replace(/```\s*$/, "")
    .trim();
}

/**
 * Explain why a batch ended with no translated segment.
 *
 * @param lastError - the last exception the batch raised, if any.
 * @param replies - replies that arrived and parsed for this batch.
 * @returns one short, user-facing sentence.
 */
function describeBatchFailure(lastError: unknown, replies: number): string {
  if (lastError) {
    return lastError instanceof Error ? lastError.message : String(lastError);
  }
  if (replies) {
    return "The service replied, but the reply contained none of the requested segments.";
  }
  return "The request could not be completed.";
}

/**
 * Translate every unit, with retries and caching.
 *
 * @param units - paragraphs to translate.
 * @param options - provider, languages and progress callback.
 * @returns one result per unit, in the same order.
 */
export async function translateUnits(
  units: TranslationUnit[],
  options: TranslateOptions,
): Promise<TranslationResult[]> {
  const {
    profile,
    targetLang,
    sourceLang,
    systemPromptExtra,
    onProgress,
    signal,
    onBatchFailure,
    resume,
    glossary = [],
    qualityAudit = true,
  } = options;
  const cache = new TranslationCache(profile, targetLang, systemPromptExtra);
  await cache.load();

  const results = new Map<string, TranslationResult>();
  const pending: TranslationUnit[] = [];
  const key = (unit: TranslationUnit) => `${unit.pageIndex}:${unit.paragraphIndex}`;

  let tokens = 0;
  let done = 0;
  /** Paragraphs a resumed run already had, for the progress label. */
  let restored = 0;
  const report = (stage: string) =>
    onProgress?.({ done, total: units.length, stage, tokens });

  for (const unit of units) {
    // The cache is a cross-run convenience the user opts into; the resume store
    // belongs to one interrupted run and comes second, so an enabled cache still
    // wins over a partial file.
    const hit = cache.get(unit.source) ?? resume?.get(key(unit));
    if (hit !== undefined) {
      results.set(key(unit), {
        pageIndex: unit.pageIndex,
        paragraphIndex: unit.paragraphIndex,
        translated: hit,
        failed: false,
      });
      if (cache.get(unit.source) === undefined) {
        restored++;
      }
      done++;
    } else {
      pending.push(unit);
    }
  }
  report(
    restored
      ? `cache: ${done - restored} cached, ${restored} resumed of ${units.length}`
      : `cache: ${done} of ${units.length}`,
  );

  const budget = getPref<number>("batchChars") || 1800;
  const batches = makeBatches(pending, budget);
  const concurrency = Math.max(1, profile.concurrency ?? getPref<number>("concurrency") ?? 4);
  const maxRetries = Math.max(1, getPref<number>("maxRetries") ?? 3);
  const timeoutMs = Math.max(15, getPref<number>("requestTimeoutSec") ?? 120) * 1000;

  const baseSystem = systemPrompt(targetLang, [
    systemPromptExtra,
    sourceLang && sourceLang !== "auto" ? `The source language is ${sourceLang}.` : "",
  ]
    .filter(Boolean)
    .join("\n"));

  await mapLimit(batches, concurrency, async (batch, batchIndex) => {
    if (signal?.aborted) {
      return;
    }
    const segments: Segment[] = batch.map((unit, index) => ({ i: index, t: unit.source }));
    let outstanding = batch.map((_, index) => index);
    let attempt = 0;
    /** Indices of this batch that produced a usable translation. */
    const translated: number[] = [];
    /** Last failure of this batch, kept so a batch that translated nothing can explain itself. */
    let lastError: unknown;
    /** Replies that arrived and parsed, to tell a broken endpoint from a broken reply. */
    let replies = 0;
    // Terms that this batch actually mentions. Injected per batch rather than
    // globally: a 300-entry glossary would otherwise ride along on every request.
    const terms = glossaryBlock(glossary, batch.map((unit) => unit.source).join("\n"));
    const system = terms ? `${baseSystem}\n\n${terms}` : baseSystem;

    while (outstanding.length && attempt < maxRetries && !signal?.aborted) {
      attempt++;
      for (const index of outstanding) {
        const unit = batch[index];
        report(
          `translating page ${unit.pageIndex + 1} (batch ${batchIndex + 1}/${batches.length}, attempt ${attempt})`,
        );
      }
      // Each request is numbered from zero, including a retry that only carries
      // the outstanding segments. Sending a retry with the original, now
      // non-contiguous indices asked the model to renumber a 0..n-1 list into
      // gaps, and every paragraph that did so exhausted the retries.
      const asked = outstanding;
      try {
        const reply = await complete({
          profile,
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content: userPrompt(asked.map((index, position) => ({ i: position, t: segments[index].t }))),
            },
          ],
          jsonMode: true,
          timeoutMs,
          signal,
        });
        if (reply.usage?.totalTokens) {
          tokens += reply.usage.totalTokens;
        }
        replies++;
        const parsed = parseSegments(reply.content);
        const stillMissing: number[] = [];
        for (const [position, index] of asked.entries()) {
          const unit = batch[index];
          const text = parsed.get(position);
          if (text === undefined) {
            stillMissing.push(index);
            continue;
          }
          // Checked for every segment, not only the ones that carry a formula:
          // a hallucinated token in formula-free prose is matched by nothing at
          // render time and would be typeset as literal characters.
          if (!placeholdersIntact(unit.source, text)) {
            stillMissing.push(index);
            continue;
          }
          results.set(key(unit), {
            pageIndex: unit.pageIndex,
            paragraphIndex: unit.paragraphIndex,
            translated: text,
            failed: false,
          });
          translated.push(index);
          cache.set(unit.source, text);
          resume?.set(key(unit), text);
          done++;
        }
        outstanding = stillMissing;
      } catch (error) {
        if (signal?.aborted) {
          return;
        }
        lastError = error;
        const retryable =
          error instanceof ApiError ? error.status === 429 || error.status >= 500 : true;
        if (!retryable || attempt >= maxRetries) {
          ztoolkit.log(`batch ${batchIndex + 1} failed permanently`, error);
          break;
        }
        await delay(500 * 2 ** (attempt - 1));
      }
    }

    // A batch that produced nothing at all is worth reporting by reason: with
    // one dead endpoint every batch lands here, and "472 paragraph(s) kept their
    // original text" is not something a reader can act on.
    if (outstanding.length === batch.length) {
      onBatchFailure?.(describeBatchFailure(lastError, replies));
    }

    // Second pass over the batch's own successes. A reply can carry every
    // segment and every placeholder yet still be truncated or still in English,
    // and that is the defect readers actually hit. One corrective request names
    // the problem; a reply that is no better than the first is discarded, and a
    // reply that is merely shorter than ideal is kept.
    if (qualityAudit && translated.length && !signal?.aborted) {
      await repairSuspectSegments({
        batch,
        usable: translated,
        results,
        key,
        profile,
        system,
        timeoutMs,
        signal,
        targetLang,
        onTokens: (count) => {
          tokens += count;
        },
        onRepaired: (unit, text) => {
          cache.set(unit.source, text);
          resume?.set(key(unit), text);
        },
      });
    }

    // Anything still unresolved keeps its source text and is flagged, so the
    // reader sees which paragraphs were not translated instead of a silent gap.
    for (const index of outstanding) {
      const unit = batch[index];
      results.set(key(unit), {
        pageIndex: unit.pageIndex,
        paragraphIndex: unit.paragraphIndex,
        translated: unit.source,
        failed: true,
      });
      done++;
    }
    // Persist after every batch: a crash then costs one batch of work, not the
    // whole document.
    await resume?.flush();
    report(`translated ${done}/${units.length}`);
  });

  // A cancel can arrive between two batches, after the last flush; one final
  // write keeps every completed paragraph on disk.
  await resume?.flush();
  await cache.save();

  return units.map(
    (unit) =>
      results.get(key(unit)) ?? {
        pageIndex: unit.pageIndex,
        paragraphIndex: unit.paragraphIndex,
        translated: unit.source,
        failed: true,
      },
  );
}

interface RepairArgs {
  /** Segments of the batch, indexed as they were sent. */
  batch: TranslationUnit[];
  /** Indices of `batch` that already have a translation. */
  usable: number[];
  results: Map<string, TranslationResult>;
  key: (unit: TranslationUnit) => string;
  profile: ProviderProfile;
  /** The batch's system prompt, glossary included. */
  system: string;
  timeoutMs: number;
  signal?: AbortSignal;
  targetLang: string;
  /** Called with the token usage of the repair request. */
  onTokens: (count: number) => void;
  /** Called when a repaired reply replaces the stored one. */
  onRepaired: (unit: TranslationUnit, translated: string) => void;
}

/**
 * Re-request the segments of one batch whose reply looks damaged.
 *
 * Only the flagged segments are sent, numbered from zero, so the repair costs a
 * fraction of the batch. The replacement is accepted only when it is strictly
 * better by the audit's own count: a second reply that loses a placeholder or
 * scores worse is discarded, because the first reply is at least complete.
 *
 * @param args - batch, existing results and transport options.
 */
async function repairSuspectSegments(args: RepairArgs): Promise<void> {
  const { batch, usable, results, key, profile, system, timeoutMs, signal, targetLang } = args;
  const flagged: Array<{ index: number; issues: QualityIssue[] }> = [];
  for (const index of usable) {
    const unit = batch[index];
    const current = results.get(key(unit));
    if (!current || current.failed) {
      continue;
    }
    const issues = auditTranslation(unit.source, current.translated, targetLang);
    if (issues.length) {
      flagged.push({ index, issues });
    }
  }
  if (!flagged.length) {
    return;
  }

  const hints = correctionHints(flagged.flatMap((entry) => entry.issues));
  const instruction = [
    "Correction pass. Some segments in the previous reply were damaged.",
    "Translate the segments below again, completely, into the target language.",
    "Problems reported:",
    ...hints.map((hint) => `- ${hint}`),
  ].join("\n");

  try {
    const reply = await complete({
      profile,
      messages: [
        { role: "system", content: `${system}\n\n${instruction}` },
        {
          role: "user",
          content: userPrompt(
            flagged.map((entry, position) => ({ i: position, t: batch[entry.index].source })),
          ),
        },
      ],
      jsonMode: true,
      timeoutMs,
      signal,
    });
    if (reply.usage?.totalTokens) {
      args.onTokens(reply.usage.totalTokens);
    }
    const parsed = parseSegments(reply.content);
    for (const [position, entry] of flagged.entries()) {
      const unit = batch[entry.index];
      const text = parsed.get(position);
      if (text === undefined || !placeholdersIntact(unit.source, text)) {
        continue;
      }
      const remaining = auditTranslation(unit.source, text, targetLang);
      if (remaining.length >= entry.issues.length) {
        // No better than what is already stored: keep the first reply and only
        // record that it is still suspect.
        const current = results.get(key(unit));
        if (current) {
          current.quality = "suspect";
        }
        continue;
      }
      results.set(key(unit), {
        pageIndex: unit.pageIndex,
        paragraphIndex: unit.paragraphIndex,
        translated: text,
        failed: false,
        quality: remaining.length ? "suspect" : "retried",
      });
      args.onRepaired(unit, text);
    }
  } catch (error) {
    // A repair pass is an improvement, never a requirement: keep the batch.
    ztoolkit.log("quality repair pass failed", error);
  }
}

/** Sleep, honouring an abort signal would be nicer but is not needed here. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
