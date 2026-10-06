/**
 * Where the exported PDF goes.
 *
 * Three modes, because "next to the source PDF" means different things for the
 * two kinds of attachment Zotero manages:
 *
 *  - a *linked* attachment lives in the user's own folder, so writing next to it
 *    is exactly what the user expects and carries no risk;
 *  - a *stored* attachment lives in `<dataDir>/storage/<KEY>/`, which belongs to
 *    Zotero and is inspected by file sync. Writing there works but the file is
 *    not tracked, so the plugin defaults to importing it as a proper attachment
 *    instead and warns in the UI.
 */

import { getPref, type OutputMode } from "../../utils/prefs";
import { fileStem, parentDirectory } from "../../utils/items";

export interface ResolvedOutput {
  /** Absolute path the PDF will be written to. */
  path: string;
  /** Directory containing it. */
  directory: string;
  /** How the path was chosen, for the confirmation message. */
  mode: OutputMode;
  /** True when the target directory is inside Zotero's own storage. */
  insideZoteroStorage: boolean;
}

/** Sanitize a file name stem for the host platform. */
function safeStem(stem: string): string {
  const cleaned = Zotero.File.getValidFileName(stem, true);
  return cleaned.replace(/\.+$/, "").trim() || "document";
}

/**
 * Work out the output path for a translated PDF.
 *
 * @param attachment - the source PDF attachment.
 * @param sourcePath - its absolute path on disk.
 * @returns the target path and how it was derived.
 * @throws when the custom directory is not configured.
 */
export function resolveOutput(
  attachment: Zotero.Item,
  sourcePath: string,
): ResolvedOutput {
  const mode = getPref<OutputMode>("outputMode") ?? "same-dir";
  const suffix = getPref<string>("suffix") || ".bilingual";
  const stem = safeStem(fileStem(sourcePath));
  const fileName = `${stem}${suffix}.pdf`;

  if (mode === "custom") {
    const configured = (getPref<string>("customOutputDir") ?? "").trim();
    if (!configured) {
      throw new Error(
        "No output folder is configured. Set one in the plugin settings, or switch to \"next to the source PDF\".",
      );
    }
    return {
      path: PathUtils.join(configured, fileName),
      directory: configured,
      mode,
      insideZoteroStorage: false,
    };
  }

  if (mode === "storage") {
    const directory = Zotero.Attachments.getStorageDirectory(attachment).path;
    return {
      path: PathUtils.join(directory, fileName),
      directory,
      mode,
      insideZoteroStorage: true,
    };
  }

  const directory = parentDirectory(sourcePath);
  const storageRoot = PathUtils.join(Zotero.DataDirectory.dir, "storage");
  return {
    path: PathUtils.join(directory, fileName),
    directory,
    mode: "same-dir",
    insideZoteroStorage: directory.startsWith(storageRoot),
  };
}

/**
 * Make a path that does not clobber an existing file.
 *
 * @param path - desired absolute path.
 * @param overwrite - when true the path is returned unchanged.
 * @returns the path to use.
 */
export async function uniquePath(
  path: string,
  overwrite: boolean,
): Promise<string> {
  if (overwrite || !(await IOUtils.exists(path))) {
    return path;
  }
  const directory = parentDirectory(path);
  const name = PathUtils.filename(path);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let index = 2; index < 500; index++) {
    const candidate = PathUtils.join(directory, `${stem} (${index})${extension}`);
    if (!(await IOUtils.exists(candidate))) {
      return candidate;
    }
  }
  throw new Error(`Could not find a free file name in ${directory}`);
}

/**
 * Write the exported PDF, creating the directory when needed.
 *
 * @param path - absolute target path.
 * @param bytes - PDF contents.
 * @returns the path actually written.
 * @throws when the directory is not writable, with an actionable message.
 */
export async function writePdf(path: string, bytes: Uint8Array): Promise<string> {
  const directory = parentDirectory(path);
  try {
    await Zotero.File.createDirectoryIfMissingAsync(directory);
    await IOUtils.write(path, bytes);
    return path;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not write to ${directory}: ${reason}. ` +
        "Pick a different output folder in the plugin settings.",
    );
  }
}

/**
 * Attach the exported PDF to the item.
 *
 * @param attachment - the source PDF attachment.
 * @param path - the exported file.
 * @param title - display name for the new attachment.
 * @returns the created attachment item.
 */
export async function attachToItem(
  attachment: Zotero.Item,
  path: string,
  title: string,
): Promise<Zotero.Item | undefined> {
  const parentID = attachment.parentItemID ?? undefined;
  const created = await Zotero.Attachments.importFromFile({
    file: path,
    libraryID: attachment.libraryID,
    ...(parentID ? { parentItemID: parentID } : {}),
    title,
  });
  return created ? created : undefined;
}
