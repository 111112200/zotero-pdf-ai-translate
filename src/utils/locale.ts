/**
 * Fluent localization for plugin-owned strings.
 *
 * `addon/locale/<locale>/*.ftl` is registered automatically by Zotero, and the
 * scaffold prefixes every file name and message id with the addon ref. Using
 * Fluent rather than hardcoded labels keeps the plugin translatable and matches
 * how Zotero itself localizes UI text.
 */

let l10n: Localization | undefined;

/** Fluent files shipped by this plugin, without the locale directory. */
const FILES = ["mainWindow.ftl", "preferences.ftl", "addon.ftl"] as const;

/**
 * Resolve and cache the Fluent bundle for the plugin's locale.
 *
 * @returns the bundle, created on first use.
 */
export function initLocale(): Localization {
  if (!l10n) {
    l10n = new Localization(
      FILES.map((file) => `${addonRef}-${file}`),
      true,
    );
  }
  return l10n;
}

/**
 * Format one Fluent message.
 *
 * @param id - message id without the addon prefix, e.g. `menu-translate`.
 * @param args - optional Fluent arguments.
 * @returns the formatted string, or the id itself when the message is missing,
 *   so a missing translation degrades to something diagnosable rather than blank.
 */
export function t(id: string, args?: Record<string, string | number>): string {
  const full = `${addonRef}-${id}`;
  try {
    const message = initLocale().formatValueSync(full, args);
    return message ?? full;
  } catch (error) {
    ztoolkit.log(`missing Fluent message: ${full}`, error);
    return full;
  }
}
