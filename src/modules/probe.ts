/**
 * Diagnostics for the highest-risk assumptions.
 *
 * Everything the plugin depends on that lives outside its own code — Zotero's
 * pdf.js build, the worker, font-name resolution, text extraction — is checked
 * here and written to a report the user can paste into a bug report.
 */

import { extractPages } from "./extract";
import { isPDFJSAvailable, loadPDFJS, pdfjsVersion } from "./extract/pdfjs";
import { getItem } from "../utils/items";

/** Fixed location so the user can find the report without a file picker. */
const REPORT_NAME = "pdf-ai-translate-log.txt";

/**
 * Append a line to the plugin's log file next to the Zotero data directory.
 *
 * @param line - text to append; a newline is added.
 */
export async function appendLog(line: string): Promise<void> {
  try {
    const path = PathUtils.join(
      Zotero.DataDirectory.dir,
      REPORT_NAME,
    );
    const stamp = new Date().toISOString();
    const existing = (await IOUtils.exists(path))
      ? await IOUtils.readUTF8(path)
      : "";
    await IOUtils.writeUTF8(path, `${existing}${stamp}  ${line}\n`);
  } catch (error) {
    ztoolkit.log("could not write the log file", error);
  }
}

/** Absolute path of the log file, for display in dialogs. */
export function logPath(): string {
  return PathUtils.join(Zotero.DataDirectory.dir, REPORT_NAME);
}

/**
 * Collect environment facts that determine whether extraction can work.
 *
 * @returns a human-readable multi-line report.
 */
export function describeEnvironment(): string {
  const lines: string[] = [];
  lines.push(`Zotero      : ${Zotero.version}`);
  lines.push(`Plugin      : ${addonRef} ${buildVersion}`);
  lines.push(`pdf.js      : ${isPDFJSAvailable() ? pdfjsVersion() : "UNAVAILABLE"}`);
  if (isPDFJSAvailable()) {
    const pdfjs = loadPDFJS();
    lines.push(`workerSrc   : ${pdfjs.GlobalWorkerOptions.workerSrc}`);
  }
  return lines.join("\n");
}

/**
 * Run the self-check and report the result in a dialog.
 *
 * Uses the first selected PDF attachment when the library has one, so the check
 * exercises the real extraction path rather than a synthetic document.
 */
export async function probeEnvironment(): Promise<void> {
  const report: string[] = [describeEnvironment()];

  const attachment = firstSelectedPDF();
  if (!attachment) {
    report.push("");
    report.push(
      "No PDF attachment is selected. Select one in the library and run the check again.",
    );
    await showReport(report.join("\n"));
    return;
  }

  report.push(`Attachment  : ${attachment.libraryKey}`);
  const path = await attachment.getFilePathAsync();
  if (!path) {
    report.push("Attachment file is missing on disk.");
    await showReport(report.join("\n"));
    return;
  }
  report.push(`File        : ${path}`);

  const started = Date.now();
  try {
    const bytes = await IOUtils.read(path);
    const pages = await extractPages(new Uint8Array(bytes), { firstPage: 1, lastPage: 2 });
    report.push(`Extracted   : ${pages.length} page(s) in ${Date.now() - started} ms`);

    for (const page of pages) {
      let mathSpans = 0;
      let chars = 0;
      let formulaBlocks = 0;
      for (const paragraph of page.paragraphs) {
        chars += paragraph.source.length;
        mathSpans += paragraph.math.filter((span) => span.token).length;
        if (paragraph.isFormulaBlock) {
          formulaBlocks++;
        }
      }
      report.push("");
      report.push(
        `page ${page.index + 1}: ${Math.round(page.width)}x${Math.round(page.height)}pt ` +
          `rotate=${page.rotate} paragraphs=${page.paragraphs.length} ` +
          `formulaBlocks=${formulaBlocks} chars=${chars} ` +
          `inlineMath=${mathSpans} images=${page.imageCount}`,
      );
      for (const sample of page.paragraphs.slice(0, 3)) {
        const preview = sample.source.slice(0, 100);
        const tag = sample.isFormulaBlock ? "[formula]" : "[text]";
        report.push(
          `   ${tag} box=(${Math.round(sample.box.left)},${Math.round(sample.box.top)})` +
            `..(${Math.round(sample.box.right)},${Math.round(sample.box.bottom)}) ` +
            `${preview}${sample.source.length > 100 ? "…" : ""}`,
        );
      }
    }
  } catch (error) {
    report.push(`EXTRACTION FAILED: ${String(error)}`);
    if (error instanceof Error && error.stack) {
      report.push(error.stack);
    }
  }

  const text = report.join("\n");
  await appendLog(text.replace(/\n/g, "\n           "));
  await showReport(`${text}\n\nFull log: ${logPath()}`);
}

/** The first selected item that is, or has, a PDF attachment. */
function firstSelectedPDF(): Zotero.Item | undefined {
  const pane = Zotero.getActiveZoteroPane();
  const items = pane?.getSelectedItems?.() ?? [];
  for (const item of items) {
    if (item.isPDFAttachment?.()) {
      return item;
    }
  }
  for (const item of items) {
    for (const id of item.getAttachments?.() ?? []) {
      const attachment = getItem(id);
      if (attachment?.isPDFAttachment?.()) {
        return attachment;
      }
    }
  }
  return undefined;
}

/**
 * Surface a report to the user.
 *
 * The full text always goes to the log file; the dialog carries the first
 * screenful, which is enough to answer "did extraction work".
 */
async function showReport(text: string): Promise<void> {
  const head = text.length > 1400 ? `${text.slice(0, 1400)}\n…` : text;
  const win = Zotero.getMainWindow();
  Services.prompt.alert(
    win as unknown as mozIDOMWindowProxy,
    `${addonName} — self check`,
    `${head}\n\nFull report: ${logPath()}`,
  );
}
