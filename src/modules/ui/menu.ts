/**
 * Context menu registration.
 *
 * Zotero 10 provides `Zotero.MenuManager`, so no DOM injection is needed (that
 * was only required on Zotero 7). Menus registered under this plugin's id are
 * removed by Zotero when the plugin shuts down, but an explicit unregister is
 * kept so a development reload does not accumulate duplicates.
 *
 * `main/library/item` and `main/library/collection` are grouped targets: Zotero
 * moves overflow into its own submenu and rejects top-level separators. The
 * shape below therefore keeps one prominent action at the top level and hides
 * the rest behind a submenu.
 */

import { getItem } from "../../utils/items";
import { isBusy, cancelActiveTask, startTranslation } from "../task";
import { probeEnvironment } from "../probe";
import { PANE_ID } from "./prefsPane";

const MENU_ID = "pdfaitranslate-item-menu";
const TOOLS_MENU_ID = "pdfaitranslate-tools-menu";

/**
 * Context handed to menu hooks by `Zotero.MenuManager`.
 *
 * Declared locally rather than imported: the published `zotero-types` still
 * models the Zotero 7 shape, where `setL10nArgs` takes an object.
 */
interface MenuContext {
  items?: Zotero.Item[];
  setEnabled?: (enabled: boolean) => void;
  setVisible?: (visible: boolean) => void;
  menuElem?: Element;
}

/**
 * Translate the plugin's menu elements in the window that owns them.
 *
 * `Zotero.MenuManager` puts `data-l10n-id` on the elements it creates but never
 * asks the document to translate them, and its own code for loading a plugin's
 * Fluent file is commented out. Elements created after the document has loaded
 * are not translated automatically either, so without this every item appears
 * with no text — present, sized, clickable and blank.
 *
 * The Fluent file itself is registered with the window at startup; this only has
 * to trigger the translation once the elements exist.
 *
 * @param context - menu context, which carries the element that was built.
 */
function translateMenuLabels(context: MenuContext): void {
  const doc = context.menuElem?.ownerDocument as
    | (Document & {
        l10n?: { translateFragment?: (node: Node) => Promise<void> };
      })
    | undefined;
  const translate = doc?.l10n?.translateFragment;
  if (!doc || typeof translate !== "function") {
    return;
  }
  for (const node of doc.querySelectorAll(`[data-l10n-id^="${addonRef}-"]`)) {
    const element = node as Element;
    if (element.getAttribute("label") || element.textContent?.trim()) {
      continue;
    }
    void translate.call(doc.l10n, element).catch(() => {
      // A missing string leaves one item blank; it must not break the menu.
    });
  }
}

/**
 * Compose a menu entry's `onShowing` with the label fix.
 *
 * Every entry runs the fix, because opening any one of them is the first moment
 * the elements exist.
 *
 * @param entry - menu data to wrap.
 * @returns the entry with a combined `onShowing` hook.
 */
function withLabels(entry: MenuEntry): MenuEntry {
  const original = entry.onShowing as
    | ((event: Event, context: MenuContext) => void)
    | undefined;
  return {
    ...entry,
    onShowing: (event: Event, context: MenuContext) => {
      original?.(event, context);
      translateMenuLabels(context);
    },
  };
}

/**
 * Resolve the PDF attachment to translate from the current selection.
 *
 * Accepts either an attachment row or a regular item that has a PDF child, so
 * the same command works whether the user right-clicks the paper or the file.
 *
 * @param items - items from the menu context.
 * @returns the attachment to translate, or `undefined` when the selection has none.
 */
export function resolveAttachment(
  items: Zotero.Item[] | undefined,
): Zotero.Item | undefined {
  if (!items?.length) {
    return undefined;
  }
  for (const item of items) {
    if (item.isPDFAttachment?.()) {
      return item;
    }
  }
  for (const item of items) {
    if (!item.isRegularItem?.()) {
      continue;
    }
    for (const id of item.getAttachments?.() ?? []) {
      const attachment = getItem(id);
      if (attachment?.isPDFAttachment?.()) {
        return attachment;
      }
    }
  }
  return undefined;
}

/** One entry of the `menus` array; typed loosely so stale types cannot block. */
type MenuEntry = Record<string, unknown>;

/** Menu items contributed under the library item context menu. */
function menuEntries(): MenuEntry[] {
  return [
    withLabels({
      menuType: "menuitem",
      l10nID: `${addonRef}-menu-translate`,
      onShowing: (_event: Event, context: MenuContext) => {
        const attachment = resolveAttachment(context.items);
        context.setVisible?.(Boolean(attachment));
        context.setEnabled?.(Boolean(attachment) && !isBusy());
      },
      onCommand: async (_event: Event, context: MenuContext) => {
        const attachment = resolveAttachment(context.items);
        if (!attachment) {
          return;
        }
        await startTranslation(attachment);
      },
    }),
    withLabels({
      menuType: "submenu",
      l10nID: `${addonRef}-menu-root`,
      menus: [
        withLabels({
          menuType: "menuitem",
          l10nID: `${addonRef}-menu-cancel`,
          onShowing: (_event: Event, context: MenuContext) => {
            context.setVisible?.(isBusy());
          },
          onCommand: () => {
            cancelActiveTask();
          },
        }),
        withLabels({
          menuType: "menuitem",
          l10nID: `${addonRef}-menu-settings`,
          onCommand: () => {
            Zotero.Utilities.Internal.openPreferences(PANE_ID);
          },
        }),
        withLabels({
          menuType: "menuitem",
          l10nID: `${addonRef}-menu-probe`,
          onCommand: async () => {
            await probeEnvironment();
          },
        }),
      ],
    }),
  ];
}

/**
 * Register the plugin's menus.
 *
 * Two targets: the library item context menu, where a translation is started,
 * and the Tools menubar menu, which is the only place a user can reach the
 * settings without first selecting an item. Zotero's own Settings window always
 * carries the pane, but it is buried behind Edit → Settings and is not where
 * anyone looks for a plugin's options first.
 *
 * @param pluginID - this plugin's addon id, used by Zotero for ownership.
 */
export function registerMenus(pluginID: string): void {
  Zotero.MenuManager.registerMenu({
    menuID: MENU_ID,
    pluginID,
    target: "main/library/item",
    menus: menuEntries(),
  } as never);

  Zotero.MenuManager.registerMenu({
    menuID: TOOLS_MENU_ID,
    pluginID,
    target: "main/menubar/tools",
    menus: [
      { menuType: "separator" },
      withLabels({
        menuType: "menuitem",
        l10nID: `${addonRef}-menu-translate-tools`,
        onCommand: async () => {
          // Reuse the current library selection, so the Tools entry works
          // without a right-click.
          const pane = Zotero.getActiveZoteroPane();
          const attachment = resolveAttachment(pane?.getSelectedItems?.());
          if (!attachment) {
            Zotero.alert(
              Zotero.getMainWindow(),
              "PDF AI Translate",
              "Select a paper or its PDF attachment in your library first.",
            );
            return;
          }
          await startTranslation(attachment);
        },
      }),
      withLabels({
        menuType: "menuitem",
        l10nID: `${addonRef}-menu-probe`,
        onCommand: async () => {
          await probeEnvironment();
        },
      }),
      withLabels({
        menuType: "menuitem",
        l10nID: `${addonRef}-menu-settings`,
        onCommand: () => {
          Zotero.Utilities.Internal.openPreferences(PANE_ID);
        },
      }),
    ],
  } as never);
}

/** Remove the menus; safe to call when they were never registered. */
export function unregisterMenus(): void {
  for (const id of [MENU_ID, TOOLS_MENU_ID]) {
    try {
      Zotero.MenuManager.unregisterMenu(id);
    } catch (error) {
      ztoolkit.log(`menu teardown failed for ${id}`, error);
    }
  }
}
