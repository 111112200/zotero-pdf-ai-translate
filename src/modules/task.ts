/**
 * End-to-end orchestration for one PDF: extract, translate, render, export.
 *
 * Only one run is allowed at a time. Zotero gives no cheap way to attribute a
 * half-finished export to a cancelled run, so a second request is refused rather
 * than queued, and a cancelled run stops before writing anything.
 */

import { createTaskProgress, type TaskProgress } from "./ui/progress";
import { getPref } from "../utils/prefs";
import { extractPages } from "./extract";
import type { PageContent } from "./extract/types";
import {
  attachToItem,
  resolveOutput,
  uniquePath,
  writePdf,
} from "./output/paths";
import { renderBilingual } from "./render/bilingual";
import { translateUnits, type TranslationUnit } from "./translate/pipeline";
import { resolveActiveProfile } from "./translate/profile";

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
  const results = await translateUnits(units, {
    profile,
    targetLang,
    sourceLang,
    systemPromptExtra: getPref<string>("systemPromptExtra") || "",
    signal: controller.signal,
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

  const target = resolveOutput(attachment, sourcePath);
  const finalPath = await uniquePath(target.path, getPref<boolean>("overwrite"));
  await writePdf(finalPath, rendered.bytes);

  const notes: string[] = [];
  if (failed) {
    notes.push(`${failed} paragraph(s) kept their original text`);
  }
  if (rendered.overflowBoxes) {
    notes.push(`${rendered.overflowBoxes} paragraph(s) did not fit their original box`);
  }
  if (rendered.preservedMathParagraphs) {
    notes.push(`${rendered.preservedMathParagraphs} paragraph(s) kept their original text because a math font could not be decoded`);
  }
  if (rendered.missingGlyphs.length) {
    notes.push(
      `the font cannot render: ${rendered.missingGlyphs.slice(0, 20).join("")}`,
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
