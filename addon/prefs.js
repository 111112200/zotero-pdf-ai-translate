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

// --- Extraction ------------------------------------------------------------
pref("skipReferences", false);
pref("firstPage", 0);
pref("lastPage", 0);

// --- Bilingual PDF layout --------------------------------------------------
pref("bilingualLayout", "left-right");
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
pref("cjkFontPath", "");
pref("fallbackFontPath", "");

// --- Misc ------------------------------------------------------------------
pref("cacheEnabled", true);
pref("debug", false);
