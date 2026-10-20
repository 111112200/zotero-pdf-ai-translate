/* Default preferences. The scaffold prefixes every key with
 * `extensions.zotero.pdfaitranslate.` at build time. */

// --- Translation service ---------------------------------------------------
// Provider profiles are stored as a JSON array so that a user can keep several
// services side by side and switch without retyping keys.
// See src/modules/translate/providers.ts for the built-in presets.
pref("providers", "[]");
pref("activeProviderId", "deepseek");
pref("model", "");
pref("baseURL", "");
pref("apiKey", "");
pref("temperature", 0.2);
pref("concurrency", 4);
pref("requestTimeoutSec", 120);
pref("maxRetries", 3);
pref("batchChars", 1800);
pref("systemPromptExtra", "");

// --- Language --------------------------------------------------------------
pref("sourceLang", "auto");
pref("targetLang", "zh-CN");

// --- Pages -----------------------------------------------------------------
// 0 means "no bound": firstPage 0 starts at the first page, lastPage 0 runs to
// the end.
pref("firstPage", 0);
pref("lastPage", 0);

// --- Terminology and quality -----------------------------------------------
// `source,target` lines, one entry per line; see translate/glossary.ts.
pref("glossary", "");
// Re-request a paragraph whose reply looks truncated or was never translated.
pref("qualityAudit", true);
// Offer to continue an interrupted run of the same document.
pref("resumePartial", true);

// --- Bilingual PDF layout --------------------------------------------------
pref("originalOnLeft", true);
pref("columnGapPt", 12);
pref("drawDivider", true);

// --- Output ----------------------------------------------------------------
// same-dir | custom | storage
pref("outputMode", "same-dir");
pref("customOutputDir", "");
pref("suffix", ".bilingual.zh-CN");
pref("overwrite", false);
pref("addAsAttachment", true);
pref("openAfterExport", false);
pref("revealAfterExport", false);

// --- Fonts -----------------------------------------------------------------
// Empty means the bundled Noto Sans SC subset; any TTF/OTF path overrides it.
pref("cjkFontPath", "");

// --- Misc ------------------------------------------------------------------
// Off by default: every run asks the service again, so a reply that echoed the
// source or came from a half-broken endpoint is never frozen into the next
// export. Turn this on deliberately to stop paying for the same paragraphs.
pref("cacheEnabled", false);
pref("debug", false);
