/**
 * End-to-end self check.
 *
 * Everything the plugin depends on that lives outside its own code — Zotero's
 * pdf.js build, the worker, font-name resolution, reading the bundled font from
 * the add-on root, and pdf-lib's subset embedder — is exercised here against a
 * synthetic document, so a broken installation can be diagnosed from a single
 * log line instead of by clicking through the UI.
 *
 * The synthetic document matters: a real paper would depend on the user's
 * library, and the point of the check is to run on a fresh install.
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { extractPages } from "./extract";
import { isPDFJSAvailable, loadPDFJS, pdfjsVersion } from "./extract/pdfjs";
import { renderBilingual } from "./render/bilingual";
import { loadTranslationFont } from "./render/fonts";
import { translateUnits } from "./translate/pipeline";
import { PANE_ID } from "./ui/prefsPane";

/** Build a one-page document shaped like a single-column paper page. */
async function makeSamplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const page = doc.addPage([595, 842]);
  page.drawText("Self check document", { x: 56, y: 780, size: 18, font });
  const body = [
    "The dominant sequence transduction models are based on complex recurrent or",
    "convolutional neural networks that include an encoder and a decoder. The best",
    "performing models also connect the encoder and decoder through an attention",
    "mechanism. We propose a new simple network architecture, the Transformer.",
  ];
  body.forEach((line, index) => {
    page.drawText(line, { x: 56, y: 730 - index * 15, size: 10.5, font });
  });
  page.drawRectangle({
    x: 56,
    y: 600,
    width: 200,
    height: 90,
    borderColor: rgb(0.3, 0.3, 0.3),
    borderWidth: 1,
  });
  return await doc.save();
}

/**
 * Run the self check.
 *
 * @returns a human-readable report; never throws.
 */
export async function runSelfTest(): Promise<string> {
  const lines: string[] = [`Zotero ${Zotero.version}, plugin ${buildVersion}`];

  lines.push(...(await probeSandbox()));
  lines.push(...probePDFJS());
  lines.push(...probePreferencesPane());

  try {
    const fontBytes = await loadTranslationFont();
    lines.push(
      fontBytes
        ? `font: ${fontBytes.length} bytes loaded from the add-on package`
        : "font UNAVAILABLE — rendering cannot work",
    );
  } catch (error) {
    lines.push(`font probe failed: ${String(error)}`);
  }

  try {
    const sample = await makeSamplePdf();
    lines.push(`sample document: ${sample.length} bytes`);
    const pages = await extractPages(sample);
    const paragraphCount = pages.reduce((n, p) => n + p.paragraphs.length, 0);
    lines.push(
      `extraction: ${pages.length} page(s), ${paragraphCount} paragraph(s), ` +
        `page size ${Math.round(pages[0]?.width ?? 0)}x${Math.round(pages[0]?.height ?? 0)}`,
    );
    for (const paragraph of pages[0]?.paragraphs.slice(0, 3) ?? []) {
      const box = paragraph.box;
      lines.push(
        `  box=(${box.left.toFixed(0)},${box.top.toFixed(0)})-` +
          `(${box.right.toFixed(0)},${box.bottom.toFixed(0)}) ` +
          `lines=${paragraph.lineBoxes.length} "${paragraph.source.slice(0, 48)}"`,
      );
    }
  } catch (error) {
    lines.push(`extraction FAILED: ${String(error)}`);
  }

  try {
    const bytes = await renderSample();
    lines.push(`render: output ${bytes.length} bytes`);
  } catch (error) {
    lines.push(`render FAILED: ${String(error)}`);
  }

  lines.push(...(await probeTranslation()));
  lines.push(...(await probeMenuLabels()));
  lines.push(...(await probePrefsWindow()));

  return lines.join("\n");
}

/**
 * Resolve the menu strings through the main window's localization.
 *
 * A missing translation is invisible in the UI — the menu item is there, sized
 * and clickable, with no text — so the only reliable check is to ask the
 * window's `l10n` for the values the menu declares.
 */
async function probeMenuLabels(): Promise<string[]> {
  const win = Zotero.getMainWindow() as unknown as { document: Document };
  if (!win?.document) {
    return ["menu labels: no main window to resolve against"];
  }
  const doc = win.document;
  const selector = `[data-l10n-id^="${addonRef}-"]`;

  // Menu items are built when the popup opens, so a freshly started window has
  // none yet. Replaying `popupshowing`, which is what MenuManager listens for,
  // builds them without opening anything on screen.
  for (const popup of Array.from<Element>(
    doc.querySelectorAll("menubar > menu > menupopup"),
  )) {
    try {
      popup.dispatchEvent(new Event("popupshowing"));
    } catch (error) {
      ztoolkit.log("could not replay popupshowing", error);
    }
  }

  const nodes = Array.from<Element>(doc.querySelectorAll(selector));
  if (!nodes.length) {
    return [
      "menu labels: no menu elements were created by replaying popupshowing",
      ...describeL10n(),
    ];
  }
  const read = (node: Element): string => {
    const label =
      node.getAttribute("label") ??
      (node as unknown as { label?: string }).label ??
      "";
    return label || (node.textContent ?? "").trim();
  };
  let blank = nodes.filter((node) => !read(node));
  if (blank.length) {
    // Give the translation the menu's own `onShowing` hook kicked off a moment
    // to land; the hook cannot be awaited from here.
    for (let attempt = 0; attempt < 10 && blank.length; attempt++) {
      await Zotero.Promise.delay(100);
      blank = nodes.filter((node) => !read(node));
    }
  }
  const rendered = nodes.map(
    (node) => `${node.getAttribute("data-l10n-id")}=${JSON.stringify(read(node))}`,
  );
  if (blank.length) {
    return [
      `menu labels BLANK on ${blank.length}/${nodes.length}: ${rendered.join(" ")}`,
      ...describeL10n(),
    ];
  }
  return [`menu labels: ${nodes.length} rendered: ${rendered.join(" ")}`];
}

/** Report what the localization registry and the window actually contain. */
function describeL10n(): string[] {
  const out: string[] = [];
  try {
    const mainWin = Zotero.getMainWindow() as unknown as Window & {
      document: Document;
      L10nRegistry?: {
        getInstance: () => {
          getSourceNames: () => string[];
          hasSource: (name: string) => boolean;
          sources: Map<string, { locales: string[] }>;
          generateBundlesSync?: (
            locales: string[],
            resourceIds: string[],
          ) => Iterable<{
            hasMessage?: (id: string) => boolean;
            getMessage?: (id: string) => unknown;
          }>;
        };
      };
    };
    const hrefs = Array.from(
      mainWin.document.querySelectorAll('link[rel="localization"]'),
    ).map((node) => (node as Element).getAttribute("href"));
    out.push(`  main window localization links: ${hrefs.join(", ") || "(none)"}`);

    const registry = mainWin.L10nRegistry?.getInstance();
    if (!registry) {
      out.push("  L10nRegistry is not reachable from the main window");
      return out;
    }
    out.push(`  l10n sources: ${registry.getSourceNames().join(", ")}`);

    const locales = Services.locale.appLocalesAsBCP47;
    out.push(`  app locales: ${locales.join(", ")}`);
    const resourceId = `${addonRef}-mainWindow.ftl`;
    if (!registry.generateBundlesSync) {
      out.push("  generateBundlesSync is unavailable");
      return out;
    }
    const bundles = Array.from(
      registry.generateBundlesSync(locales, [resourceId]),
    );
    out.push(`  bundles for ${resourceId}: ${bundles.length}`);
    const has = bundles.some((bundle) =>
      bundle.hasMessage?.(`${addonRef}-menu-settings`),
    );
    out.push(`  bundle contains ${addonRef}-menu-settings: ${has}`);
  } catch (error) {
    out.push(`  l10n inspection failed: ${String(error)}`);
  }
  return out;
}

/**
 * Open the settings window and confirm the pane actually renders.
 *
 * Parsing the markup only proves it is well formed. Whether the pane is wired up
 * — script loaded, `load` handler fired, controls bound — can only be seen in
 * the real window, and a pane that opens blank is otherwise silent.
 */
async function probePrefsWindow(): Promise<string[]> {
  const win = Zotero.Utilities.Internal.openPreferences(PANE_ID) as
    | (Window & {
        Zotero_Preferences?: {
          panes: Map<string, { container: Element }>;
          navigateToPane: (id: string) => Promise<void>;
        };
      })
    | undefined;
  if (!win) {
    return ["settings window: could not be opened"];
  }
  try {
    await win.Zotero_Preferences?.navigateToPane(PANE_ID);
    // The pane loads asynchronously; give the fragment a moment to appear.
    for (let attempt = 0; attempt < 20; attempt++) {
      const container = win.Zotero_Preferences?.panes.get(PANE_ID)?.container;
      const popup = container?.querySelector(`#${addonRef}-provider-popup`);
      if (popup && popup.children.length > 0) {
        const inputs = container?.querySelectorAll("[preference]").length ?? 0;
        const provider = (
          win.document.getElementById(`zotero-prefpane-${addonRef}-provider`) as
            | XULMenuListElement
            | null
        )?.value;
        return [
          `settings pane rendered: ${popup.children.length} provider(s) listed, ` +
            `${inputs} bound control(s), selection "${provider ?? ""}"`,
        ];
      }
      await Zotero.Promise.delay(150);
    }
    return [
      "settings pane rendered but the provider list is EMPTY — " +
        "the pane load handler did not run",
    ];
  } catch (error) {
    return [`settings window probe failed: ${String(error)}`];
  }
}

/**
 * Parse the settings pane the way Zotero does, and report what it binds.
 *
 * Zotero loads a pane with `MozXULElement.parseXULToFragment(markup, dtdFiles)`,
 * where `dtdFiles` are only Zotero's own DTDs. An entity reference such as
 * `&my-plugin-label;` is therefore undefined and the parser rejects the whole
 * fragment, which surfaces as a sidebar entry that opens an empty pane, with no
 * error anywhere in the UI.
 *
 * `MozXULElement` is a window global that Zotero 10 does not expose to plugin
 * sandboxes, but the parse it performs is a `DOMParser` run over the markup
 * wrapped in a DOCTYPE that pulls in those two DTDs, which is reproducible here.
 */
function probePreferencesPane(): string[] {
  try {
    const url = `${rootURI}content/preferences.xhtml`;
    const markup = Zotero.File.getContentsFromURL(url);
    const entities = [
      "chrome://zotero/locale/zotero.dtd",
      "chrome://zotero/locale/preferences.dtd",
    ];
    const preamble = entities
      .map(
        (href, index) =>
          `<!ENTITY % _dtd-${index} SYSTEM "${href}"> %_dtd-${index}; `,
      )
      .join("");
    const wrapped =
      `<!DOCTYPE bindings [ ${preamble}]>` +
      `<box xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul" ` +
      `xmlns:html="http://www.w3.org/1999/xhtml">` +
      `${markup}</box>`;

    const parser = new DOMParser() as DOMParser & {
      parseFromSafeString?: (source: string, type: string) => Document;
    };
    const doc = parser.parseFromSafeString
      ? parser.parseFromSafeString(wrapped, "application/xml")
      : parser.parseFromString(wrapped, "application/xml");
    const root = doc.documentElement;
    if (!root || root.localName === "parsererror") {
      throw new Error(root?.textContent ?? "not well-formed");
    }
    const count = doc.querySelectorAll("[preference]").length;
    const ids = doc.querySelectorAll("[data-l10n-id]").length;
    return [
      `settings pane: parsed OK, ${markup.length} bytes, ` +
        `${count} preference binding(s), ${ids} localized string(s)`,
    ];
  } catch (error) {
    return [
      `settings pane FAILED TO PARSE: ${String(error)} ` +
        "(the pane will open blank)",
    ];
  }
}

/** Where the mock OpenAI server listens during development. */
const MOCK_ENDPOINT = "http://127.0.0.1:8765/v1";

/**
 * Exercise the chat client against the local mock server, when it is running.
 *
 * This is the only way to check the request format, the reply contract and the
 * retry path without spending the user's API credits, so it is skipped silently
 * when nothing is listening.
 */
async function probeTranslation(): Promise<string[]> {
  const out: string[] = [];
  const profile = {
    id: "mock",
    preset: "custom",
    label: "mock",
    baseURL: MOCK_ENDPOINT,
    apiKey: "test-key",
    model: "mock-model",
    jsonMode: true,
    concurrency: 2,
  };

  try {
    const reachable = await Zotero.HTTP.request("POST", `${MOCK_ENDPOINT}/chat/completions`, {
      body: JSON.stringify({
        model: "probe",
        messages: [{ role: "user", content: JSON.stringify({ segments: [] }) }],
      }),
      headers: { "Content-Type": "application/json" },
      responseType: "text",
      successCodes: false,
      errorDelayMax: 0,
      timeout: 4000,
    });
    if (reachable.status >= 400) {
      out.push(`translation: mock endpoint replied ${reachable.status}, skipping`);
      return out;
    }
  } catch {
    out.push("translation: mock endpoint not running, skipping");
    return out;
  }

  try {
    const units = [
      { pageIndex: 0, paragraphIndex: 0, source: "Self check document", mathCount: 0 },
      {
        pageIndex: 0,
        paragraphIndex: 1,
        source: "Attention is all you need, see ⟦M1⟧ for details.",
        mathCount: 1,
      },
      { pageIndex: 0, paragraphIndex: 2, source: "A third paragraph for batching.", mathCount: 0 },
    ];
    const results = await translateUnits(units, {
      profile,
      targetLang: "zh-CN",
      sourceLang: "en",
      systemPromptExtra: "",
    });
    const failed = results.filter((r) => r.failed).length;
    out.push(
      `translation: ${results.length} segment(s), ${failed} fell back to source`,
    );
    out.push(`  first: "${results[0]?.translated.slice(0, 48)}"`);
    out.push(`  math:  "${results[1]?.translated.slice(0, 48)}"`);
  } catch (error) {
    out.push(`translation FAILED: ${String(error)}`);
  }
  return out;
}

/**
 * Report whether the sandbox's intrinsics can be extended and whether the
 * worker URL pdf.js needs is reachable.
 */
async function probeSandbox(): Promise<string[]> {
  const out: string[] = [];
  try {
    const proto = Map.prototype as unknown as Record<string, unknown>;
    out.push(
      `Map.prototype extensible: ${Object.isExtensible(Map.prototype)}, ` +
        `getOrInsertComputed: ${typeof proto.getOrInsertComputed}`,
    );
    if (typeof proto.getOrInsertComputed !== "function") {
      proto.getOrInsertComputed = function (
        this: Map<unknown, unknown>,
        key: unknown,
        callback: (k: unknown) => unknown,
      ) {
        if (!this.has(key)) {
          this.set(key, callback(key));
        }
        return this.get(key);
      };
      out.push("installed a getOrInsertComputed polyfill");
    }
  } catch (error) {
    out.push(`sandbox probe failed: ${String(error)}`);
  }

  for (const url of [
    `chrome://${addonRef}/content/scripts/pdf.worker.min.mjs`,
    "resource://zotero/reader/pdf/build/pdf.worker.mjs",
  ]) {
    try {
      const worker = new Worker(url, { type: "module" });
      worker.terminate();
      out.push(`module worker OK: ${url}`);
    } catch (error) {
      out.push(`module worker failed (${url}): ${String(error)}`);
    }
  }
  return out;
}

/** Probe pdf.js and report exactly why it failed. */
function probePDFJS(): string[] {
  const out: string[] = [];
  if (!isPDFJSAvailable()) {
    out.push("pdf.js UNAVAILABLE");
    return out;
  }
  try {
    out.push(`pdf.js ${pdfjsVersion()} (bundled pdfjs-dist)`);
    out.push(`worker: ${loadPDFJS().GlobalWorkerOptions.workerSrc}`);
  } catch (error) {
    out.push(`pdf.js probe threw: ${String(error)}`);
  }
  return out;
}

/** Render the sample document through the real overlay renderer. */
async function renderSample(): Promise<Uint8Array> {
  const sample = await makeSamplePdf();
  const pages = await extractPages(sample);
  const translations = new Map<string, string>();
  pages.forEach((page) =>
    page.paragraphs.forEach((paragraph, index) => {
      if (!paragraph.isFormulaBlock) {
        translations.set(
          `${page.index}:${index}`,
          `【自检】${paragraph.source.slice(0, 30)}`,
        );
      }
    }),
  );
  const result = await renderBilingual({
    sourceBytes: sample,
    pages,
    translations,
  });
  return result.bytes;
}
