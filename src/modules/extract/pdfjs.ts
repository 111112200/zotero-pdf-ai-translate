/**
 * Access to pdf.js.
 *
 * The plugin ships its own `pdfjs-dist` rather than loading Zotero's bundled
 * build. Zotero's `resource://zotero/reader/pdf/build/pdf.mjs` assigns to
 * `Map.prototype` when `getOrInsertComputed` is missing, and
 * `ChromeUtils.importESModule` evaluates modules in a realm whose intrinsics are
 * not extensible, so importing it from the plugin sandbox throws before any page
 * can be parsed. `pdfjs-dist` has no such assignment, and a bundled dependency
 * is evaluated in the sandbox's own realm, where `Map.prototype` is extensible.
 *
 * The worker is shipped alongside the add-on and referenced through the
 * `chrome://` package `bootstrap.js` registers, which resolves the same way
 * whether the add-on is loaded from a directory or from an XPI.
 */

import * as pdfjs from "pdfjs-dist";

const WORKER_URL = `chrome://${addonRef}/content/scripts/pdf.worker.min.mjs`;

/** The pdf.js module namespace. */
type PDFJSNamespace = typeof pdfjs;

interface PDFDocumentLike {
  numPages: number;
  getPage: (pageNumber: number) => Promise<unknown>;
  getMetadata: () => Promise<{ info?: Record<string, unknown> }>;
  destroy: () => Promise<void>;
}

/** The subset of a page `resolveFontName` needs. */
export interface FontResolvablePage {
  commonObjs: { has: (name: string) => boolean; get: (name: string) => unknown };
}

let workerConfigured = false;

/**
 * Load pdf.js and point it at the bundled worker.
 *
 * @returns the pdf.js namespace.
 * @throws when the worker cannot be configured, which would make every parse
 *   fail with an opaque error later.
 */
export function loadPDFJS(): PDFJSNamespace {
  if (!workerConfigured) {
    // Outside Zotero there is no `Worker` and no `chrome://` scheme; the
    // offline layout harness sets a file URL instead.
    if (typeof Worker !== "undefined") {
      pdfjs.GlobalWorkerOptions.workerSrc = WORKER_URL;
    }
    workerConfigured = true;
  }
  return pdfjs;
}

/** True when pdf.js and its worker URL are usable. */
export function isPDFJSAvailable(): boolean {
  try {
    loadPDFJS();
    return true;
  } catch (error) {
    ztoolkit.log("pdf.js is unavailable", error);
    return false;
  }
}

/**
 * Operator constants used to recognize image painting.
 *
 * @returns pdf.js `OPS`, or `undefined` when the build cannot be loaded.
 */
export function pdfjsOps(): Record<string, number> | undefined {
  try {
    return loadPDFJS().OPS as unknown as Record<string, number>;
  } catch (error) {
    ztoolkit.log("pdf.js OPS are unavailable", error);
    return undefined;
  }
}

/** Version string of the pdf.js build in use, for diagnostics. */
export function pdfjsVersion(): string {
  try {
    return loadPDFJS().version;
  } catch {
    return "unavailable";
  }
}

/**
 * Open a PDF supplied as bytes.
 *
 * pdf.js normally builds its own worker from `GlobalWorkerOptions.workerSrc`,
 * but that path reads `window.location` to decide whether the URL is
 * same-origin, and the plugin sandbox has no `window`. It then falls back to a
 * "fake worker" that needs a script loader, which the sandbox also lacks, so
 * every parse fails. Creating the worker here and handing it over through
 * `workerPort` skips both.
 *
 * @param bytes - complete PDF file contents.
 * @param password - optional password for encrypted documents.
 * @returns the parsed document; the caller owns it and must call `destroy()`.
 */
export async function openDocument(
  bytes: Uint8Array,
  password?: string,
): Promise<PDFDocumentLike> {
  const pdfjsLib = loadPDFJS();

  // Node has no `Worker`; the offline layout harness relies on pdf.js's
  // main-thread fallback instead.
  let worker: Worker | undefined;
  if (typeof Worker !== "undefined") {
    try {
      worker = new Worker(WORKER_URL, { type: "module" });
      pdfjsLib.GlobalWorkerOptions.workerPort = worker;
    } catch (error) {
      throw new Error(
        `pdf.js worker could not be started from ${WORKER_URL}: ${String(error)}`,
      );
    }
  }

  // pdf.js transfers `data` to the worker, so hand it a copy: the caller still
  // needs the original bytes to embed pages into the output PDF.
  const copy = new Uint8Array(bytes);
  const task = pdfjsLib.getDocument({
    data: copy,
    password: password || undefined,
    // No network fetches from inside the worker; the add-on ships no cmaps or
    // standard fonts, and pdf.js substitutes reasonably without them.
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    // Retain converted font data for compact vector math glyphs.
    fontExtraProperties: true,
    useSystemFonts: false,
  });
  const doc = (await task.promise) as unknown as PDFDocumentLike & {
    destroy: () => Promise<void>;
  };
  const destroy = doc.destroy.bind(doc);
  doc.destroy = async () => {
    try {
      await destroy();
    } finally {
      // pdf.js terminates the port it was given; drop the reference so the next
      // document builds a fresh worker.
      if (pdfjsLib.GlobalWorkerOptions.workerPort === worker) {
        pdfjsLib.GlobalWorkerOptions.workerPort = null;
      }
      worker = undefined;
    }
  };
  return doc;
}

/**
 * Resolve the PostScript font name behind a pdf.js text item.
 *
 * pdf.js exposes fonts under generated names such as `g_d0_f3`; the real name
 * (`ABCDEF+CMMI9`) is what formula detection needs. The mapping is only
 * populated once the page's common objects have been resolved, which
 * `getOperatorList()` guarantees.
 *
 * @param page - page the text came from.
 * @param loadedName - `fontName` from a text item.
 * @returns the embedded font name, or the loaded name when it cannot be resolved.
 */
export function resolveFontName(
  page: FontResolvablePage,
  loadedName: string | undefined,
): string {
  if (!loadedName) {
    return "";
  }
  try {
    if (page.commonObjs.has(loadedName)) {
      const font = page.commonObjs.get(loadedName) as { name?: string };
      if (font && typeof font.name === "string" && font.name) {
        return font.name;
      }
    }
  } catch (error) {
    ztoolkit.log(`could not resolve font name for ${loadedName}`, error);
  }
  return loadedName;
}
