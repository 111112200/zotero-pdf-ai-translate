import { BasicTool } from "zotero-plugin-toolkit";

/**
 * The toolkit singleton, bound to this plugin's log prefix.
 *
 * @returns a configured `BasicTool`.
 */
export function createZToolkit() {
  return new BasicTool({
    log: { prefix: `[${addonRef}]` },
  } as never);
}
