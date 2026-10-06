/**
 * Preference pane behaviour: populating the provider list, testing a
 * connection, and picking an output folder.
 */

import { getPref, getProviders, setPref } from "../../utils/prefs";
import { testConnection } from "../translate/client";
import { findPreset, PROVIDER_PRESETS } from "../translate/providers";
import { resolveActiveProfile } from "../translate/profile";
import { invalidateFontCache } from "../render/fonts";

interface PrefsWindow extends Window {
  document: Document;
}

/**
 * Id of the settings pane.
 *
 * Explicit rather than generated: `Zotero.Utilities.Internal.openPreferences()`
 * navigates by pane id, so the menu entries need to know it.
 */
export const PANE_ID = "pdfaitranslate-prefpane";

/**
 * Handle an event raised from `preferences.xhtml`.
 *
 * @param type - event name: `load`, `testConnection` or `pickDir`.
 * @param data - event payload; carries the preferences `window`.
 */
export async function onPrefsEvent(
  type: string,
  data: { window?: PrefsWindow } = {},
): Promise<void> {
  const win = data.window;
  if (!win) {
    return;
  }
  switch (type) {
    case "load":
      populateProviders(win);
      await syncOutputSelection(win, true);
      break;
    case "outputChanged":
      await syncOutputSelection(win);
      break;
    case "providerChanged":
      applyProviderDefaults(win);
      break;
    case "testConnection":
      await runConnectionTest(win);
      break;
    case "pickDir":
      await pickOutputDirectory(win);
      break;
    default:
      break;
  }
}

/** Fill the provider dropdown and normalize the stored selection. */
function populateProviders(win: PrefsWindow): void {
  const popup = win.document.getElementById(`${addonRef}-provider-popup`);
  if (!popup) {
    return;
  }
  popup.replaceChildren();

  const stored = getProviders();
  const activeId = getPref<string>("activeProviderId") || "deepseek";
  const known = new Set(stored.map((entry) => entry.id));

  // Built-in presets that the user has not overridden yet.
  for (const preset of PROVIDER_PRESETS) {
    if (known.has(preset.id)) {
      continue;
    }
    popup.appendChild(makeItem(win, preset.id, preset.label));
  }
  for (const profile of stored) {
    popup.appendChild(makeItem(win, profile.id, profile.label || profile.id));
  }

  const list = win.document.getElementById(
    `zotero-prefpane-${addonRef}-provider`,
  ) as XULMenuListElement | null;
  if (list && activeId) {
    list.value = activeId;
  }
}

/** Create one `menuitem` for the provider list. */
function makeItem(win: PrefsWindow, value: string, label: string): Element {
  const item = win.document.createXULElement("menuitem");
  item.setAttribute("value", value);
  item.setAttribute("label", label);
  return item;
}

/**
 * Fill the endpoint fields from the newly selected provider.
 *
 * The stored endpoint and model are used only as a fallback by
 * `resolveActiveProfile`, which means an empty field still translates correctly
 * but shows nothing, and the pane appears broken. Writing the preset's values
 * through keeps what is displayed equal to what runs. The API key is preserved:
 * switching providers should not silently discard a key the user typed.
 *
 * @param win - the preferences window.
 */
function applyProviderDefaults(win: PrefsWindow): void {
  const list = win.document.getElementById(
    `zotero-prefpane-${addonRef}-provider`,
  ) as XULMenuListElement | null;
  const selected = list?.value;
  if (!selected) {
    return;
  }
  const stored = getProviders().find((entry) => entry.id === selected);
  const preset = findPreset(selected);
  const baseURL = stored?.baseURL || preset.baseURL;
  const model = stored?.model || preset.defaultModel;

  setPref("baseURL", baseURL);
  setPref("model", model);
  setField(win, "baseurl", baseURL);
  setField(win, "model", model);
  if (stored?.apiKey) {
    setPref("apiKey", stored.apiKey);
    setField(win, "apikey", stored.apiKey);
  }
  invalidateFontCache();
}

/** Write a value into one of the pane's inputs, by key suffix. */
function setField(win: PrefsWindow, suffix: string, value: string): void {
  const input = win.document.getElementById(
    `zotero-prefpane-${addonRef}-${suffix}`,
  ) as HTMLInputElement | null;
  if (input) {
    input.value = value;
  }
}

/** Ensure a stored profile exists for the selected provider, then ping it. */
async function runConnectionTest(win: PrefsWindow): Promise<void> {
  const result = win.document.getElementById(`${addonRef}-test-result`);
  const show = (text: string, ok: boolean) => {
    if (result) {
      result.textContent = text;
      (result as HTMLElement).style.color = ok ? "#1a7f37" : "#b42318";
    }
  };
  show("Testing…", true);
  try {
    const profile = resolveActiveProfile();
    show(await testConnection(profile), true);
  } catch (error) {
    show(error instanceof Error ? error.message : String(error), false);
  }
}

/** Let the user choose the output folder. */
async function pickOutputDirectory(win: PrefsWindow): Promise<void> {
  const filePicker = (
    ChromeUtils as unknown as {
      importESModule: (uri: string) => {
        FilePicker: new () => {
          init: (win: Window, title: string, mode: string) => void;
          appendFilter: (label: string, filter: string) => void;
          modeGetFolder: number;
          show: () => Promise<unknown>;
          file: { path: string };
        };
      };
    }
  ).importESModule("chrome://zotero/content/modules/filePicker.mjs").FilePicker;

  const picker = new filePicker();
  picker.init(win, "Choose where translated PDFs are saved", "selectFolder");
  picker.appendFilter("Folders", "*");
  picker.modeGetFolder = 2;
  try {
    await picker.show();
  } catch {
    // The user dismissed the dialog; nothing to do.
    return;
  }
  setPref("customOutputDir", picker.file.path);
  const input = win.document.getElementById(
    `zotero-prefpane-${addonRef}-customdir`,
  ) as HTMLInputElement | null;
  if (input) {
    input.value = picker.file.path;
  }
}

/** Localize menuitem labels before refreshing the menulist selected label. */
async function syncOutputSelection(win: PrefsWindow, fromPreferences = false): Promise<void> {
  const list = win.document.getElementById(`zotero-prefpane-${addonRef}-outputmode`) as XULMenuListElement | null;
  if (!list) return;
  const value = (fromPreferences ? getPref<string>("outputMode") : list.value) || "same-dir";
  if (!fromPreferences) setPref("outputMode", value);
  const doc = win.document as Document & { l10n: { translateFragment(element: Element): Promise<void> } };
  await doc.l10n.translateFragment(list);
  list.value = value;
  const item = Array.from<Element>(list.querySelectorAll("menuitem")).find(item=>item.getAttribute("value") === list.value);
  if (item) list.setAttribute("label", item.getAttribute("label") || "");
}
