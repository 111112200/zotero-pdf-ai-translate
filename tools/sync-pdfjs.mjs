/**
 * Copy the pdf.js worker into the add-on.
 *
 * pdf.js runs its parser in a worker, and the worker must be reachable at a URL
 * the plugin can hand to `new Worker()`. Shipping it inside the add-on and
 * referencing it through the `chrome://` package that `bootstrap.js` registers
 * works for both a directory install and a packaged XPI, which a path into
 * `node_modules` would not.
 *
 * Run from the `prebuild`/`prestart` hooks so the copy always matches the
 * installed `pdfjs-dist`.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(
  ROOT,
  "node_modules",
  "pdfjs-dist",
  "build",
  "pdf.worker.min.mjs",
);
const TARGET_DIR = path.join(ROOT, "addon", "content", "scripts");
const TARGET = path.join(TARGET_DIR, "pdf.worker.min.mjs");

if (!fs.existsSync(SOURCE)) {
  console.error(`pdfjs-dist worker not found at ${SOURCE}; run npm install first`);
  process.exit(1);
}

fs.mkdirSync(TARGET_DIR, { recursive: true });
fs.copyFileSync(SOURCE, TARGET);
const bytes = fs.statSync(TARGET).size;
console.log(`synced pdf.worker.min.mjs (${bytes.toLocaleString()} bytes)`);
