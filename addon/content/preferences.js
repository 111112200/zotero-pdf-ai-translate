/**
 * Settings pane bootstrap.
 *
 * Zotero dispatches a `load` event at every top-level element of a plugin pane
 * after inserting it, but it only turns `oncommand` attributes into listeners —
 * `onload` attributes are left as inert strings. The provider dropdown therefore
 * has to be filled from a real listener, which is what this file is for; it is
 * loaded through `Zotero.PreferencePanes.register({ scripts })` into a sandbox
 * whose prototype is the preferences window.
 *
 * `load` does not bubble, so the listener is registered for the capture phase on
 * the document. The attributes are matched rather than namespaced so that the id
 * check works for the pane this plugin registered.
 */

(function () {
  var PREFIX = "zotero-prefpane-__addonRef__";

  /**
   * Whether a top-level pane element belongs to this plugin's pane.
   *
   * @param {Element} node - element the `load` event was dispatched at.
   * @returns {boolean} true when the element is part of our pane.
   */
  function isOurs(node) {
    if (!node || node.nodeType !== 1) {
      return false;
    }
    if (node.id && node.id.indexOf(PREFIX) === 0) {
      return true;
    }
    return Boolean(node.querySelector && node.querySelector('[id^="' + PREFIX + '"]'));
  }

  document.addEventListener(
    "load",
    function (event) {
      if (!isOurs(event.target)) {
        return;
      }
      Zotero.__addonInstance__.hooks.onPrefsEvent("load", { window: window });
    },
    true,
  );
})();
