/**
 * Plugin bootstrap. Runs in Zotero's privileged plugin sandbox.
 *
 * The sandbox exposes Zotero, Services, ChromeUtils, IOUtils, PathUtils,
 * Worker, ChromeWorker, fetch and the usual web primitives (verified against
 * the installed Zotero 10.0.3 `chrome/content/zotero/xpcom/plugins.js`).
 */

/* global Zotero, Services, Components, IOUtils, PathUtils, APP_SHUTDOWN */

var chromeHandle;

/**
 * Record a lifecycle failure where the user can find it.
 *
 * `Zotero.debug` output is invisible unless debug logging is enabled, so a throw
 * inside `startup()` would otherwise leave the plugin silently absent.
 *
 * @param {string} stage - which lifecycle step failed.
 * @param {unknown} error - the thrown value.
 */
function reportFailure(stage, error) {
  try {
    const line =
      `${new Date().toISOString()}  ${stage}: ` +
      `${error && error.stack ? error.stack : String(error)}\n`;
    let dir;
    try {
      dir = Zotero.DataDirectory.dir;
    } catch (inner) {
      dir = PathUtils.profileDir;
    }
    IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true })
      .then(() =>
        IOUtils.writeUTF8(PathUtils.join(dir, "pdf-ai-translate-log.txt"), line, {
          mode: "append",
        }),
      )
      .catch(() => {});
  } catch (inner) {
    // Nothing further can be done from here.
  }
}

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  try {
    const aomStartup = Components.classes[
      "@mozilla.org/addons/addon-manager-startup;1"
    ].getService(Components.interfaces.amIAddonManagerStartup);
    const manifestURI = Services.io.newURI(rootURI + "manifest.json");
    chromeHandle = aomStartup.registerChrome(manifestURI, [
      ["content", "__addonRef__", rootURI + "content/"],
    ]);

    const ctx = { rootURI };
    ctx._globalThis = ctx;

    Services.scriptloader.loadSubScript(
      `${rootURI}/content/scripts/__addonRef__.js`,
      ctx,
    );
    await Zotero.__addonInstance__.hooks.onStartup();
  } catch (error) {
    reportFailure("startup", error);
    throw error;
  }
}

async function onMainWindowLoad({ window }, reason) {
  await Zotero.__addonInstance__?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }, reason) {
  await Zotero.__addonInstance__?.hooks.onMainWindowUnload(window);
}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  await Zotero.__addonInstance__?.hooks.onShutdown();

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall(data, reason) {}
