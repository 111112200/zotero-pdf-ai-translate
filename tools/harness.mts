/**
 * Runs the plugin's real extraction and rendering code outside Zotero.
 *
 * The plugin modules read a handful of globals that Zotero injects (`Zotero`,
 * `ztoolkit`, `IOUtils`, `PathUtils`, `rootURI`, …). This harness installs
 * stand-ins for them so the same source files can be exercised against a real
 * paper, which makes layout regressions visible without restarting Zotero for
 * every change.
 *
 * The plugin bundles `pdfjs-dist`, so no module-loader shim is needed. The
 * `chrome://` worker URL cannot resolve in Node, which is fine: `openDocument`
 * skips the explicit worker when `Worker` is absent and lets pdf.js use its
 * main-thread parser.
 *
 * Usage:
 *   node --import tsx tools/harness.mts <input.pdf> [out.pdf]
 *        [--pages=1-3] [--zh=translations.json] [--dump] [--all] [--lines]
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as pdfjs from "pdfjs-dist";

const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..");
const INPUT = process.argv[2];
const OUTPUT =
  process.argv[3] && !process.argv[3].startsWith("--")
    ? process.argv[3]
    : path.join(PLUGIN_ROOT, "tools", "_out", "bilingual.pdf");
const PAGE_RANGE = process.argv.find((a) => a.startsWith("--pages="))?.slice(8);
const TRANSLATION_FILE = process.argv.find((a) => a.startsWith("--zh="))?.slice(5);
const [from, to] = (PAGE_RANGE ?? "1-1").split("-").map((v) => Number(v) || 1);

if (!INPUT) {
  console.error(
    "usage: harness.mts <input.pdf> [out.pdf] [--pages=1-3] [--zh=file.json] [--dump] [--lines]",
  );
  process.exit(1);
}

const prefPrefix = "extensions.zotero.pdfaitranslate";
const prefs = new Map<string, unknown>([
  [`${prefPrefix}.columnGapPt`, 12],
  [`${prefPrefix}.drawDivider`, true],
  [`${prefPrefix}.originalOnLeft`, true],
  [`${prefPrefix}.cjkFontPath`, ""],
]);

const logs: string[] = [];
const globals = globalThis as unknown as Record<string, unknown>;

globals.Zotero = {
  Prefs: {
    get: (key: string) => prefs.get(key),
    set: (key: string, value: unknown) => prefs.set(key, value),
  },
  DataDirectory: { dir: path.join(PLUGIN_ROOT, "tools", "_out") },
  File: {
    getBinaryContentsAsync: async (source: string) => {
      const local = source.replace(/^.*?content\//, "addon/content/");
      return fs.readFileSync(path.resolve(PLUGIN_ROOT, local), "latin1");
    },
    getValidFileName: (name: string) => name.replace(/[\\/:*?"<>|]/g, "_"),
  },
  HTTP: { request: async () => ({ status: 200, response: new ArrayBuffer(0) }) },
  getMainWindow: () => ({ alert: (m: string) => logs.push(`ALERT ${m}`) }),
  debug: (m: string) => logs.push(m),
  version: "harness",
};
globals.IOUtils = {
  read: async (p: string) => new Uint8Array(fs.readFileSync(p)),
  write: async (p: string, b: Uint8Array) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, b);
  },
  exists: async (p: string) => fs.existsSync(p),
  readUTF8: async (p: string) => fs.readFileSync(p, "utf8"),
  writeUTF8: async (p: string, s: string) => fs.writeFileSync(p, s, "utf8"),
};
globals.PathUtils = {
  join: (...parts: string[]) => path.join(...parts),
  parent: (p: string) => path.dirname(p),
  filename: (p: string) => path.basename(p),
  isAbsolute: (p: string) => path.isAbsolute(p),
};
globals.Services = {
  prompt: { alert: (_w: unknown, t: string, m: string) => logs.push(`${t}: ${m}`) },
};
globals.ztoolkit = { log: (...args: unknown[]) => logs.push(args.map(String).join(" ")) };
globals.rootURI = `file:///${path.join(PLUGIN_ROOT, "addon").replace(/\\/g, "/")}/`;
globals.addonRef = "pdfaitranslate";
globals.addonName = "PDF AI Translate";
globals.addonID = "pdf-ai-translate@111112200.github.io";
globals.addonInstance = "PDFAITranslate";
globals.buildVersion = "harness";
globals.prefsPrefix = prefPrefix;
globals.__env__ = "development";

// The plugin sets a `chrome://` worker URL, which Node cannot load. Point
// pdf.js at the worker on disk so its main-thread parser works offline.
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  path.join(PLUGIN_ROOT, "node_modules", "pdfjs-dist", "build", "pdf.worker.mjs"),
).href;

const bytes = new Uint8Array(fs.readFileSync(INPUT));

/** Line-level view of one page, for diagnosing grouping and column detection. */
async function dumpLines(): Promise<void> {
  const { openDocument, resolveFontName } = await import(
    "../src/modules/extract/pdfjs.ts"
  );
  const { pageGeometry } = await import("../src/modules/extract/geometry.ts");
  const { buildLines, toRuns, toReadingOrder, toParagraphs } = await import(
    "../src/modules/extract/layout.ts"
  );
  const doc = await openDocument(bytes);
  const page = (await doc.getPage(from)) as never as {
    view: number[];
    rotate: number;
    getTextContent: () => Promise<{ items: never[] }>;
    getOperatorList: () => Promise<{ fnArray: number[] }>;
    commonObjs: { has: (n: string) => boolean; get: (n: string) => unknown };
  };
  const content = await page.getTextContent();
  await page.getOperatorList();
  const geometry = pageGeometry(page.view, page.rotate);
  const runs = toRuns(content.items, geometry, (n) => resolveFontName(page, n));
  const lines = buildLines(runs);
  console.log(
    `page ${from}, runs=${runs.length} lines=${lines.length} rot=${page.rotate}`,
  );
  for (const line of toReadingOrder(lines)) {
    console.log(
      `  col=${String(line.column).padStart(2)} ` +
        `x=${line.x.toFixed(0)}..${(line.x + line.width).toFixed(0)} ` +
        `y=${line.y.toFixed(0)} ${line.text.slice(0, 62)}`,
    );
  }
  console.log(`paragraphs=${toParagraphs(toReadingOrder(lines)).length}`);
  await doc.destroy();
}

if (process.argv.includes("--lines")) {
  await dumpLines();
  process.exit(0);
}

const { extractPages } = await import("../src/modules/extract/index.ts");
const { renderBilingual } = await import("../src/modules/render/bilingual.ts");

const started = Date.now();
const pages = await extractPages(bytes, { firstPage: from, lastPage: to });
console.log(`extracted ${pages.length} page(s) in ${Date.now() - started} ms`);
if (process.argv.includes("--structure")) { fs.writeFileSync(OUTPUT + ".json", JSON.stringify(pages, null, 2)); process.exit(0); }

let paragraphCount = 0;
let formulaBlocks = 0;
let inlineMath = 0;
let chars = 0;
for (const page of pages) {
  paragraphCount += page.paragraphs.length;
  for (const paragraph of page.paragraphs) {
    if (paragraph.isFormulaBlock) {
      formulaBlocks++;
    } else {
      chars += paragraph.source.length;
    }
    inlineMath += paragraph.math.filter((span) => span.token).length;
  }
}
console.log(
  `paragraphs=${paragraphCount} formulaBlocks=${formulaBlocks} ` +
    `chars=${chars} inlineMath=${inlineMath}`,
);

// A stand-in translation: distribute the page's real Chinese text across its
// paragraphs in proportion to the source length, so the harness exercises the
// same line counts a genuine translation would produce.
const translations = new Map<string, string>();
const zhPages: string[] | Record<string,string> | undefined = TRANSLATION_FILE
  ? JSON.parse(fs.readFileSync(TRANSLATION_FILE, "utf8"))
  : undefined;

for (const page of pages) {
  const zh = (Array.isArray(zhPages) ? zhPages[page.index] ?? "" : "").replace(/\s+/g, "");
  const translatable = page.paragraphs.filter((p) => !p.isFormulaBlock);
  const totalSource = translatable.reduce((sum, p) => sum + p.source.length, 0) || 1;
  let cursor = 0;
  page.paragraphs.forEach((paragraph, index) => {
    if (paragraph.isFormulaBlock) {
      return;
    }
    const key = `${page.index}:${index}`;
    if (zhPages && !Array.isArray(zhPages)) {
      const value=zhPages[key];
      if (value !== undefined) translations.set(key,value);
      return;
    }
    if (!zh) {
      translations.set(key, `【译】${paragraph.source}`);
      return;
    }
    const share = Math.round((paragraph.source.length / totalSource) * zh.length);
    const slice = zh.slice(cursor, cursor + Math.max(share, 4));
    cursor += share;
    translations.set(key, slice || `【译】${paragraph.source}`);
  });
}

const renderStart = Date.now();
const result = await renderBilingual({
  sourceBytes: bytes,
  pages,
  translations,
  onPage: () => {},
  debug: true,
});
console.log(
  `rendered in ${Date.now() - renderStart} ms -> ${result.bytes.length} bytes, ` +
    `overflowBoxes=${result.overflowBoxes}, missingGlyphs=${result.missingGlyphs.length}`,
);

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, result.bytes);
console.log(`written ${OUTPUT}`);
if (result.missingGlyphs.length) {
  console.log(`missing: ${result.missingGlyphs.slice(0, 40).join("")}`);
}

if (process.argv.includes("--dump")) {
  const skipped = result.debug.filter((d) => !d.formulaBlock && !d.translated);
  const formulas = result.debug.filter((d) => d.formulaBlock);
  const wide = result.debug.filter(
    (d) => !d.formulaBlock && d.box.right - d.box.left > 400,
  );
  console.log(
    `decisions: ${result.debug.length} total, ${formulas.length} formula blocks, ` +
      `${skipped.length} untranslated, ${wide.length} wider than 400pt`,
  );
  for (const entry of skipped.slice(0, 12)) {
    const b = entry.box;
    console.log(
      `  SKIPPED p${entry.page} #${entry.index} ` +
        `box=(${b.left.toFixed(0)},${b.top.toFixed(0)})-` +
        `(${b.right.toFixed(0)},${b.bottom.toFixed(0)})`,
    );
  }
  if (process.argv.includes("--all")) {
    for (const entry of result.debug) {
      const b = entry.box;
      console.log(
        `p${entry.page} #${String(entry.index).padStart(3)} col=${entry.column} ` +
          `formula=${entry.formulaBlock ? "Y" : "n"} ` +
          `translated=${entry.translated ? "Y" : "n"} ` +
          `box=(${b.left.toFixed(0)},${b.top.toFixed(0)})-` +
          `(${b.right.toFixed(0)},${b.bottom.toFixed(0)}) ` +
          `lines=${entry.lineBoxes} pt=${entry.fontPt} out=${entry.lines} trunc=${entry.truncated}`,
      );
    }
  }
}

if (logs.length) {
  console.log(`--- log (${logs.length}) ---`);
  for (const line of logs.slice(0, 15)) {
    console.log("  " + line);
  }
}
