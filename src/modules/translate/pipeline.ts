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
  const { profile, targetLang, sourceLang, systemPromptExtra, onProgress, signal } = options;
  const cache = new TranslationCache(profile, targetLang, systemPromptExtra);
  await cache.load();

  const results = new Map<string, TranslationResult>();
  const pending: TranslationUnit[] = [];
  const key = (unit: TranslationUnit) => `${unit.pageIndex}:${unit.paragraphIndex}`;

  let tokens = 0;
  let done = 0;
  const report = (stage: string) =>
    onProgress?.({ done, total: units.length, stage, tokens });

  for (const unit of units) {
    const hit = cache.get(unit.source);
    if (hit !== undefined) {
      results.set(key(unit), {
        pageIndex: unit.pageIndex,
        paragraphIndex: unit.paragraphIndex,
        translated: hit,
        failed: false,
      });
      done++;
    } else {
      pending.push(unit);
    }
  }
  report(`cache: ${done} of ${units.length}`);

  const budget = getPref<number>("batchChars") || 1800;
  const batches = makeBatches(pending, budget);
  const concurrency = Math.max(1, profile.concurrency ?? getPref<number>("concurrency") ?? 4);
  const maxRetries = Math.max(1, getPref<number>("maxRetries") ?? 3);
  const timeoutMs = Math.max(15, getPref<number>("requestTimeoutSec") ?? 120) * 1000;

  const system = systemPrompt(targetLang, [
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

    while (outstanding.length && attempt < maxRetries && !signal?.aborted) {
      attempt++;
      for (const index of outstanding) {
        const unit = batch[index];
        report(
          `translating page ${unit.pageIndex + 1} (batch ${batchIndex + 1}/${batches.length}, attempt ${attempt})`,
        );
      }
      try {
        const reply = await complete({
          profile,
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content: userPrompt(outstanding.map((index) => segments[index])),
            },
          ],
          jsonMode: true,
          timeoutMs,
          signal,
        });
        if (reply.usage?.totalTokens) {
          tokens += reply.usage.totalTokens;
        }
        const parsed = parseSegments(reply.content);
        const stillMissing: number[] = [];
        for (const index of outstanding) {
          const unit = batch[index];
          const text = parsed.get(index);
          if (text === undefined) {
            stillMissing.push(index);
            continue;
          }
          if (unit.mathCount > 0 && !placeholdersIntact(unit.source, text)) {
            stillMissing.push(index);
            continue;
          }
          results.set(key(unit), {
            pageIndex: unit.pageIndex,
            paragraphIndex: unit.paragraphIndex,
            translated: text,
            failed: false,
          });
          cache.set(unit.source, text);
          done++;
        }
        outstanding = stillMissing;
      } catch (error) {
        if (signal?.aborted) {
          return;
        }
        const retryable =
          error instanceof ApiError ? error.status === 429 || error.status >= 500 : true;
        if (!retryable || attempt >= maxRetries) {
          ztoolkit.log(`batch ${batchIndex + 1} failed permanently`, error);
          break;
        }
        await delay(500 * 2 ** (attempt - 1));
      }
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
    report(`translated ${done}/${units.length}`);
  });

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

/** Sleep, honouring an abort signal would be nicer but is not needed here. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
