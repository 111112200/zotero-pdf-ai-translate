/**
 * Plugin lifecycle.
 *
 * Registration goes through Zotero's own managers, all of which take the plugin
 * id and tear their contributions down on shutdown; the explicit unregister
 * calls here exist so a development reload does not accumulate duplicates.
 */

import { registerMenus, unregisterMenus } from "./modules/ui/menu";
import { onPrefsEvent, PANE_ID } from "./modules/ui/prefsPane";
import { appendLog, logPath } from "./modules/probe";
import { cancelActiveTask } from "./modules/task";
import { runSelfTest } from "./modules/selftest";
import { getPref } from "./utils/prefs";
import { installWebGlobals } from "./utils/polyfills";

async function onStartup(): Promise<void> {
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;

  const borrowed = installWebGlobals();

  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    id: PANE_ID,
    src: `${rootURI}content/preferences.xhtml`,
    // Zotero wires up `oncommand` attributes but not `onload`, so whatever has
    // to run when the pane appears lives in this script.
    scripts: [`${rootURI}content/preferences.js`],
    label: "PDF AI Translate",
    image: `${rootURI}content/icons/favicon.png`,
  });

  registerMenus(addon.data.config.addonID);

  const localization = installMenuLocalizationEverywhere();

  addon.data.initialized = true;
  ztoolkit.log(`started, logging to ${logPath()}`);
  await appendLog(`startup: ${Zotero.version} / plugin ${buildVersion}`);
  await appendLog(`menu localization: ${localization}`);
  if (borrowed.length) {
    await appendLog(`borrowed web globals: ${borrowed.join(", ")}`);
  }

  if (getPref<boolean>("debug")) {
    await appendLog(await runSelfTest());
  }
}

/**
 * Register the menu strings in a main window.
 *
 * `Zotero.MenuManager` only writes `data-l10n-id` onto the menu elements; the
 * code that would load a plugin's Fluent file for the menu is commented out in
 * Zotero 10, so the labels stay blank — present, sized and clickable, with no
 * text — until the file is registered with that window's localization.
 *
 * Adding a `<link rel="localization">` is not enough: the main window's
 * `document.l10n` is built when the document loads and does not pick the file up
 * afterwards, which is why `Zotero.File`-level registration alone leaves the
 * labels empty. `addResourceIds` extends the window's own resource set.
 *
 * @param win - a main window.
 * @returns how the registration was performed, for the log.
 */
function installMenuLocalization(win: Window): string {
  const resourceId = `${addonRef}-mainWindow.ftl`;
  const l10n = (
    win.document as unknown as {
      l10n?: { addResourceIds?: (ids: string[]) => void };
    }
  ).l10n;
  if (typeof l10n?.addResourceIds === "function") {
    try {
      l10n.addResourceIds([resourceId]);
      return "addResourceIds";
    } catch (error) {
      ztoolkit.log("l10n.addResourceIds failed, falling back to a link", error);
    }
  }
  try {
    (
      win as unknown as {
        MozXULElement: { insertFTLIfNeeded: (name: string) => void };
      }
    ).MozXULElement.insertFTLIfNeeded(resourceId);
    return "insertFTLIfNeeded";
  } catch (error) {
    ztoolkit.log("could not register the menu localization file", error);
    return "failed";
  }
}

/**
 * Register the menu strings in every window that already exists.
 *
 * `onMainWindowLoad` only fires for windows opened after startup, so the window
 * the user is looking at would otherwise never get the file.
 *
 * @returns how many windows were updated, and by which mechanism.
 */
function installMenuLocalizationEverywhere(): string {
  const results: string[] = [];
  const enumerator = Services.wm.getEnumerator("navigator:browser");
  while (enumerator.hasMoreElements()) {
    const win = enumerator.getNext() as Window;
    results.push(installMenuLocalization(win));
  }
  return results.length ? results.join(", ") : "no windows";
}

async function onMainWindowLoad(win: Window): Promise<void> {
  installMenuLocalization(win);
}

async function onMainWindowUnload(_win: Window): Promise<void> {}

async function onShutdown(): Promise<void> {
  addon.data.alive = false;
  cancelActiveTask();
  unregisterMenus();
  await appendLog("shutdown");
}

const hooks = {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onShutdown,
  onPrefsEvent,
};

export default hooks;
