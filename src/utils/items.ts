/**
 * Small helpers around Zotero's item and path APIs, which return `false` and
 * `null` rather than throwing and so need narrowing at every call site.
 */

/**
 * Look up an item by id, treating "not found" as absent.
 *
 * `Zotero.Items.get` returns `false` for a missing id, which is easy to pass
 * along by accident.
 *
 * @param id - item id.
 * @returns the item, or `undefined`.
 */
export function getItem(id: number | false | undefined): Zotero.Item | undefined {
  if (!id) {
    return undefined;
  }
  const item = Zotero.Items.get(id);
  return item ? item : undefined;
}

/**
 * Parent directory of a path.
 *
 * `PathUtils.parent` returns `null` for a filesystem root, which is never a
 * usable output location.
 *
 * @param path - absolute path.
 * @returns the parent directory.
 * @throws when the path has no parent.
 */
export function parentDirectory(path: string): string {
  const parent = PathUtils.parent(path);
  if (!parent) {
    throw new Error(`Cannot use the filesystem root as an output folder: ${path}`);
  }
  return parent;
}

/**
 * File name without its extension.
 *
 * @param path - absolute path.
 * @returns the stem.
 */
export function fileStem(path: string): string {
  const name = PathUtils.filename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
