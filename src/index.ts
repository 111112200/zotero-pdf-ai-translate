/**
 * Entry point. Loaded by `bootstrap.js` into the plugin sandbox after the
 * content directory has been registered as a chrome package.
 *
 * `_globalThis` is the plain object `bootstrap.js` passes to `loadSubScript`.
 * That object is created inside the sandbox, so scripts loaded against it see
 * the sandbox globals (`Zotero`, `Services`, `IOUtils`, …) through the scope
 * chain — but those globals are *not* properties of `_globalThis` itself.
 * Reaching for `_globalThis.Zotero` therefore yields `undefined`.
 */

// Must come first: pdfjs-dist logs through `console`, which the sandbox lacks.
import "./utils/polyfills";

import { BasicTool } from "zotero-plugin-toolkit";
import { config } from "../package.json";
import Addon from "./addon";

const basicTool = new BasicTool();

/** The sandbox global object, used to publish the plugin instance. */
const zoteroGlobal = Zotero as unknown as Record<string, unknown>;

if (!zoteroGlobal[config.addonInstance]) {
  const instance = new Addon();
  (_globalThis as Record<string, unknown>).addon = instance;

  // `ztoolkit` is resolved lazily so modules that capture it at import time get
  // the same instance the Addon owns.
  Object.defineProperty(_globalThis, "ztoolkit", {
    get: () => instance.data.ztoolkit,
  });

  zoteroGlobal[config.addonInstance] = instance;
}

/** Exposed for debugging from Tools → Developer → Run JavaScript. */
(_globalThis as Record<string, unknown>).pdfAITranslateToolkit = basicTool;
