/**
 * End-to-end orchestration for one PDF: extract, translate, render, export.
 *
 * Only one run is allowed at a time. Zotero gives no cheap way to attribute a
 * half-finished export to a cancelled run, so a second request is refused rather
 * than queued, and a cancelled run stops before writing anything.
 */

import { createTaskProgress, type TaskProgress } from "./ui/progress";
import { getPref, type ProviderProfile } from "../utils/prefs";
import { extractPages } from "./extract";
import type { PageContent } from "./extract/types";
import {
  attachToItem,
  resolveOutput,
  uniquePath,
  writePdf,
} from "./output/paths";
import { renderBilingual, type RenderResult } from "./render/bilingual";
import {
  translateUnits,
  type TranslationResult,
  type TranslationUnit,
} from "./translate/pipeline";
import { resolveActiveProfile } from "./translate/profile";
import { hash128 } from "./translate/cache";
import { parseGlossary, glossarySignature } from "./translate/glossary";
import { PartialRun } from "./translate/resume";

export interface TaskHandle {
  cancelled: boolean;
}

let active: { handle: TaskHandle; controller: AbortController } | undefined;

/** True while a translation run is in progress. */
export function isBusy(): boolean {
  return Boolean(active);
}

/** Ask the running task to stop. It finishes cleanly without writing output. */
export function cancelActiveTask(): void {
  if (!active) {
    return;
  }
  active.handle.cancelled = true;
  active.controller.abort();
  progress?.changeHeadline("Cancelling…");
}

let progress: TaskProgress | undefined;

/** Create the in-window status panel used during translation. */
function makeProgress(): TaskProgress {
  const instance = createTaskProgress(Zotero.getMainWindow());
  instance.changeHeadline("PDF AI Translate");
  instance.show();
  return instance;
}

/**
 * Translate one PDF attachment and export the bilingual result.
 *
 * @param attachment - PDF attachment to translate.
 * @returns a short human-readable outcome, or throws with an actionable message.
 */
export async function startTranslation(
  attachment: Zotero.Item,
): Promise<string | undefined> {
  if (active) {
    Zotero.getMainWindow().alert(
      "A translation is already running. Cancel it first, or wait for it to finish.",
    );
    return undefined;
  }

  const controller = new AbortController();
  const handle: TaskHandle = { cancelled: false };
  active = { handle, controller };

  try {
    progress = makeProgress();
    return await run(attachment, handle, controller);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ztoolkit.log("translation failed", error);
    progress?.changeHeadline("Translation failed");
    progress?.addDescription(message);
    progress?.close();
    Zotero.getMainWindow().alert(`${addonName}\n\n${message}`);
    return undefined;
  } finally {
    progress?.close();
    progress = undefined;
    active = undefined;
  }
}

/**
 * Explain why a run translated nothing, or `undefined` when at least one
 * paragraph made it through.
 *
 * A run in which every request fails still returns a full set of results, each
 * flagged `failed` and carrying its source text. Exporting that produces a file
 * whose right half is the original page printed twice: the reader sees no
 * Chinese, no error, and an ordinary-looking PDF, which is exactly the failure
 * mode this guard exists to stop.
 *
 * @param results - one result per unit, as returned by `translateUnits`.
 * @param failures - reasons reported per failed batch, in arrival order.
 * @returns a message naming the most likely cause, or `undefined`.
 */
export function nothingTranslated(
  results: TranslationResult[],
  failures: string[],
): string | undefined {
  if (!results.length || results.some((result) => !result.failed)) {
    return undefined;
  }
  const reasons = failures.slice(0, 3).map((reason) => `- ${reason}`);
  return [
    `None of the ${results.length} paragraph(s) could be translated, so nothing was written.`,
    "Check the API key, the base URL and the model name in the settings, and any proxy this machine needs.",
    ...(reasons.length ? ["", "The service said:", ...reasons] : []),
  ].join("\n");
}

/**
 * Explain why the composed document carries no translation, or `undefined` when
 * at least one page does.
 *
 * The translation can succeed while every page is still left in the source
 * language: a model that echoes its input, a box the translation cannot be made
 * to fit, or a formula font that cannot be decoded. Each of those is reported by
 * the renderer, but only the totals show that *nothing* was replaced.
 *
 * @param rendered - outcome of the render pass.
 * @param pages - the extracted pages that were rendered.
 * @returns a message naming the counts, or `undefined`.
 */
export function nothingRendered(
  rendered: RenderResult,
  pages: PageContent[],
): string | undefined {
  const withText = new Set(
    pages
      .filter((page) => page.paragraphs.some((paragraph) => !paragraph.isFormulaBlock))
      .map((page) => page.index),
  );
  if (!withText.size) {
    return undefined;
  }
  const translated = [...withText].filter((index) => !rendered.skippedPages.includes(index));
  if (translated.length) {
    return undefined;
  }
  const counts = [
    [rendered.unchangedParagraphs, "came back unchanged, in the source language"],
    [rendered.preservedMathParagraphs, "kept their text because a math font could not be decoded"],
    [rendered.placeholderMismatches, "kept their text because the reply altered a formula placeholder"],
    [rendered.overflowBoxes, "did not fit their original box"],
    [rendered.renderErrors, "could not be typeset"],
  ]
    .filter(([count]) => count)
    .map(([count, reason]) => `- ${count} paragraph(s) ${reason}`);
  return [
    `Every page would have kept its original text, so nothing was written.`,
    "The translation never reached the page: check that the target language is not the source language",
    "and that the model is answering with translations rather than an echo of the input.",
    ...(counts.length ? ["", ...counts] : []),
  ].join("\n");
}

/**
 * Ask whether to continue a run that was cancelled or crashed earlier.
 *
 * Nothing is resumed silently: a partial file from three days ago may belong to
 * a different model, a different glossary or a document the user has since
 * edited, and reusing it without asking is exactly the kind of invisible state
 * that makes a translation tool untrustworthy.
 *
 * @param completed - segments the store already holds.
 * @param total - segments this run would translate.
 * @returns true when the user chose to continue.
 */
function confirmResume(completed: number, total: number): boolean {
  const win = Zotero.getMainWindow();
  if (!win) {
    return false;
  }
  const message =
    `An unfinished translation of this PDF was found on disk: ` +
    `${completed} of ${total} paragraph(s) were already translated.\n\n` +
    "Continue from there, or choose Cancel to translate everything again.";
  try {
    return Services.prompt.confirm(win as unknown as mozIDOMWindowProxy, `${addonName} · resume`, message);
  } catch (error) {
    ztoolkit.log("could not ask about the partial run", error);
    return false;
  }
}

/**
 * Open the partial run for this document when the user wants it.
 *
 * The settings are folded into the store's namespace, so a change of model,
 * target language, prompt or glossary starts a fresh run instead of mixing two
 * answers into one file.
 *
 * @param sourcePath - absolute path of the PDF.
 * @param options - settings that change the answer.
 * @returns the store to hand to the pipeline, or `undefined`.
 */
async function openPartialRun(
  sourcePath: string,
  options: {
    profile: ProviderProfile;
    targetLang: string;
    promptExtra: string;
    glossarySignature: string;
    total: number;
  },
): Promise<PartialRun | undefined> {
  if (getPref<boolean>("resumePartial") === false) {
    return undefined;
  }
  let stat: { size: number; lastModified: number };
  try {
    stat = (await IOUtils.stat(sourcePath)) as { size: number; lastModified: number };
  } catch (error) {
    ztoolkit.log("could not stat the PDF for a partial run", error);
    return undefined;
  }
  const namespace = hash128(
    [
      options.profile.baseURL,
      options.profile.model,
      options.targetLang,
      options.promptExtra,
      options.glossarySignature,
    ].join("\u0000"),
  );
  const partial = await PartialRun.open(
    { path: sourcePath, size: stat.size, mtime: stat.lastModified },
    namespace,
  );
  if (!partial) {
    return undefined;
  }
  if (!confirmResume(partial.size, options.total)) {
    await partial.clear();
    return undefined;
  }
  progress?.addDescription(`Resuming: ${partial.size} paragraph(s) already translated.`);
  return partial;
}

/** The actual pipeline, separated so cleanup always runs. */
async function run(
  attachment: Zotero.Item,
  handle: TaskHandle,
  controller: AbortController,
): Promise<string> {
  const sourcePath = await attachment.getFilePathAsync();
  if (!sourcePath) {
    throw new Error("The PDF file is missing on disk. Re-download it and retry.");
  }

  const profile = resolveActiveProfile();
  const targetLang = getPref<string>("targetLang") || "zh-CN";
  const sourceLang = getPref<string>("sourceLang") || "auto";

  progress?.addDescription("Reading the PDF…");
  const bytes = new Uint8Array(await IOUtils.read(sourcePath));
  const pages = await extractPages(bytes, {
    firstPage: getPref<number>("firstPage") || 0,
    lastPage: getPref<number>("lastPage") || 0,
  });
  if (!pages.length) {
    throw new Error("No text was found in this PDF. Scanned documents need OCR first.");
  }

  const units = collectUnits(pages);
  if (!units.length) {
    throw new Error("No translatable text was found in this PDF.");
  }
  const characters = units.reduce((sum, unit) => sum + unit.source.length, 0);
  progress?.addDescription(
    `${pages.length} page(s), ${units.length} paragraph(s), ${characters} characters.`,
  );

  progress?.addDescription(`Translating with ${profile.model}…`);
  const promptExtra = getPref<string>("systemPromptExtra") || "";
  const glossary = parseGlossary(getPref<string>("glossary") || "");
  const partial = await openPartialRun(sourcePath, {
    profile,
    targetLang,
    promptExtra,
    glossarySignature: glossarySignature(glossary),
    total: units.length,
  });
  const failures: string[] = [];
  const results = await translateUnits(units, {
    profile,
    targetLang,
    sourceLang,
    systemPromptExtra: promptExtra,
    glossary,
    resume: partial,
    qualityAudit: getPref<boolean>("qualityAudit") !== false,
    signal: controller.signal,
    onBatchFailure: (message) => {
      if (!failures.includes(message)) {
        failures.push(message);
      }
    },
    onProgress: (report) => {
      progress?.changeHeadline(
        `Translating ${report.done}/${report.total}${report.tokens ? ` · ${report.tokens} tokens` : ""}`,
      );
    },
  });

  if (handle.cancelled) {
    progress?.changeHeadline("Cancelled");
    progress?.addDescription("Nothing was written.");
    progress?.close();
    throw new Error("Translation cancelled.");
  }

  const untranslatedRun = nothingTranslated(results, failures);
  if (untranslatedRun) {
    progress?.changeHeadline("Translation failed");
    progress?.addDescription("Nothing was written.");
    throw new Error(untranslatedRun);
  }

  const failed = results.filter((result) => result.failed).length;
  const translations = new Map<string, string>();
  for (const result of results) {
    if (result.failed) continue;
    translations.set(
      `${result.pageIndex}:${result.paragraphIndex}`,
      result.translated,
    );
  }

  progress?.changeHeadline("Building the bilingual PDF…");
  const rendered = await renderBilingual({
    sourceBytes: bytes,
    pages,
    translations,
    signal: controller.signal,
    onPage: (page, total) => {
      progress?.changeHeadline(`Composing page ${page}/${total}`);
    },
  });

  if (handle.cancelled) throw new Error("Translation cancelled.");

  const unchangedRun = nothingRendered(rendered, pages);
  if (unchangedRun) {
    progress?.changeHeadline("Nothing was translated");
    progress?.addDescription("Nothing was written.");
    throw new Error(unchangedRun);
  }

  const target = resolveOutput(attachment, sourcePath);
  const finalPath = await uniquePath(target.path, getPref<boolean>("overwrite"));
  await writePdf(finalPath, rendered.bytes);
  // The document is out, so there is nothing left to resume. Keeping the file
  // would only offer the next run translations it is about to pay for anyway.
  await partial?.clear();

  const notes: string[] = [];
  if (failed) {
    notes.push(`${failed} paragraph(s) kept their original text`);
  }
  const repaired = results.filter((result) => result.quality === "retried").length;
  const suspects = results.filter((result) => result.quality === "suspect").length;
  if (repaired) {
    notes.push(`${repaired} paragraph(s) looked truncated or untranslated and were re-requested`);
  }
  if (suspects) {
    notes.push(`${suspects} paragraph(s) still look damaged after a second pass`);
  }
  if (rendered.unchangedParagraphs) {
    notes.push(`${rendered.unchangedParagraphs} paragraph(s) came back unchanged and stay in the source language`);
  }
  if (rendered.overflowBoxes) {
    notes.push(`${rendered.overflowBoxes} paragraph(s) did not fit their original box`);
  }
  if (rendered.preservedMathParagraphs) {
    notes.push(`${rendered.preservedMathParagraphs} paragraph(s) kept their original text because a math font could not be decoded`);
  }
  if (rendered.placeholderMismatches) {
    notes.push(`${rendered.placeholderMismatches} paragraph(s) kept their original text because the reply altered a formula placeholder`);
  }
  if (rendered.renderErrors) {
    notes.push(`${rendered.renderErrors} paragraph(s) could not be typeset and kept their original text`);
  }
  if (rendered.missingGlyphs.length) {
    notes.push(
      `the font cannot render: ${rendered.missingGlyphs.slice(0, 20).join("")}`,
    );
  }
  if (rendered.skippedPages.length) {
    notes.push(
      `page(s) left in the original language: ${rendered.skippedPages.map((page) => page + 1).join(", ")}`,
    );
  }
  const firstPage = getPref<number>("firstPage") || 0;
  const lastPage = getPref<number>("lastPage") || 0;
  if (firstPage > 1 || lastPage > 0) {
    notes.push(
      `only the pages in the configured range were exported (page ${firstPage || 1}` +
        `${lastPage ? `–${lastPage}` : " to the end"})`,
    );
  }

  let attached: Zotero.Item | undefined;
  if (getPref<boolean>("addAsAttachment") !== false) {
    try {
      attached = await attachToItem(
        attachment,
        finalPath,
        `${PathUtils.filename(finalPath).replace(/\.pdf$/i, "")}`,
      );
      if (!attached) notes.push("it could not be added to the item automatically");
    } catch (error) {
      ztoolkit.log("could not add the PDF as an attachment", error);
      notes.push("it could not be added to the item automatically");
    }
  }

  if (target.insideZoteroStorage && !attached) {
    notes.push("the exported file is inside the Zotero data directory and has not been added as an attachment");
  }

  progress?.changeHeadline("Done");
  progress?.addDescription(PathUtils.filename(finalPath));
  for (const note of notes) {
    progress?.addDescription(`Note: ${note}`);
  }
  progress?.close();
  if (notes.length) ztoolkit.log("translation export notes", notes);
  if (notes.length) {
    Zotero.getMainWindow().alert(`${addonName}\n\n${PathUtils.filename(finalPath)}\n${notes.join("\n")}`);
  }

  if (getPref<boolean>("openAfterExport") && attached?.id) {
    Zotero.Reader.open(attached.id).catch((error: unknown) => {
      ztoolkit.log("could not open the exported PDF", error);
    });
  } else if (getPref<boolean>("revealAfterExport")) {
    await Zotero.File.reveal(finalPath).catch((error: unknown) => {
      ztoolkit.log("could not reveal the exported PDF", error);
    });
  }

  return finalPath;
}

/** Flatten pages into translation units, skipping display formulas. */
function collectUnits(pages: PageContent[]): TranslationUnit[] {
  const units: TranslationUnit[] = [];
  for (const page of pages) {
    page.paragraphs.forEach((paragraph, index) => {
      if (paragraph.isFormulaBlock || !paragraph.source.trim()) {
        return;
      }
      units.push({
        pageIndex: page.index,
        paragraphIndex: index,
        source: paragraph.source,
        mathCount: paragraph.math.filter((span) => span.token).length,
      });
    });
  }
  return units;
}
