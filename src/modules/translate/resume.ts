/**
 * Partial-run store.
 *
 * Turning the cross-run translation cache off (0.1.7) made cancelling expensive:
 * every finished paragraph lived only in memory, so stopping a sixty-page run at
 * ninety percent threw away all of it. This store keeps the finished segments of
 * *one interrupted run* and offers them back the next time the same document is
 * translated with the same settings.
 *
 * It is deliberately not a cache:
 *
 *  - it is offered once, through a confirmation dialog, never reused silently;
 *  - it expires after a week, so a stale translation cannot outlive its subject;
 *  - it is deleted the moment a run finishes, so the next run starts clean.
 *
 * The identity is the file's path, size and modification time. Editing the PDF
 * therefore starts a new run rather than resuming text that no longer matches.
 */

import { hash128 } from "./cache";

const DIRECTORY = "pdf-ai-translate-partial";
/** Bump when the entry shape changes; older files are discarded. */
const VERSION = 1;
/** A week-old half-finished run is more likely to mislead than to help. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** What identifies the document a partial run belongs to. */
export interface SourceIdentity {
  /** Absolute path of the PDF. */
  path: string;
  /** Size in bytes. */
  size: number;
  /** Last modification time, in milliseconds. */
  mtime: number;
}

interface PartialFile {
  version: number;
  /** ISO timestamp of the last flush. */
  savedAt: string;
  namespace: string;
  entries: Record<string, string>;
}

/**
 * The shape the translation pipeline needs, so tests can run without a
 * filesystem and the pipeline stays unaware of where the data lives.
 */
export interface TranslationRunStore {
  /** Previously translated text for `page:paragraph`, if any. */
  get(key: string): string | undefined;
  /** Remember one finished segment. */
  set(key: string, translated: string): void;
  /** Write everything remembered so far. */
  flush(): Promise<void>;
}

/** Directory holding every partial run, created on demand. */
function directory(): string {
  return PathUtils.join(Zotero.DataDirectory.dir, DIRECTORY);
}

/** Path of the partial file for one document. */
function pathFor(source: SourceIdentity): string {
  const key = hash128(`${source.path}\u0000${source.size}\u0000${source.mtime}`);
  return PathUtils.join(directory(), `${key}.json`);
}

/** A writable store of one interrupted run. */
export class PartialRun implements TranslationRunStore {
  private readonly entries: Map<string, string>;
  private dirty = false;
  /** Serializes writes so two batches finishing together cannot interleave. */
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private readonly namespace: string,
    entries: Map<string, string>,
  ) {
    this.entries = entries;
  }

  /**
   * Open the partial run for a document, if a usable one exists.
   *
   * @param source - identity of the PDF being translated.
   * @param namespace - settings signature; a run made with other settings is not reused.
   * @returns the store, or `undefined` when there is nothing to continue.
   */
  static async open(
    source: SourceIdentity,
    namespace: string,
  ): Promise<PartialRun | undefined> {
    const file = pathFor(source);
    try {
      if (!(await IOUtils.exists(file))) {
        return undefined;
      }
      const parsed = JSON.parse(await IOUtils.readUTF8(file)) as PartialFile;
      const age = Date.now() - Date.parse(parsed?.savedAt ?? "");
      if (
        parsed?.version !== VERSION ||
        parsed.namespace !== namespace ||
        !Number.isFinite(age) ||
        age > MAX_AGE_MS
      ) {
        await IOUtils.remove(file, { ignoreAbsent: true }).catch(() => undefined);
        return undefined;
      }
      const entries = new Map(
        Object.entries(parsed.entries ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
      if (!entries.size) {
        return undefined;
      }
      return new PartialRun(file, namespace, entries);
    } catch (error) {
      ztoolkit.log("partial run could not be read; starting fresh", error);
      return undefined;
    }
  }

  /** Number of finished segments this run can supply. */
  get size(): number {
    return this.entries.size;
  }

  get(key: string): string | undefined {
    return this.entries.get(key);
  }

  set(key: string, translated: string): void {
    this.entries.set(key, translated);
    this.dirty = true;
  }

  /**
   * Persist what has been translated so far.
   *
   * Called after every batch, so a crash costs at most one batch of work. A
   * failed write is logged and ignored: losing the safety net must not lose the
   * translation that is running.
   */
  async flush(): Promise<void> {
    if (!this.dirty) {
      return this.queue;
    }
    this.dirty = false;
    const payload: PartialFile = {
      version: VERSION,
      savedAt: new Date().toISOString(),
      namespace: this.namespace,
      entries: Object.fromEntries(this.entries),
    };
    this.queue = this.queue.then(async () => {
      try {
        await IOUtils.makeDirectory(directory(), { ignoreExisting: true, createAncestors: true });
        // Write beside the target, then move: an interrupted write must not be
        // mistaken for a complete earlier run on the next start.
        const temporary = `${this.file}.tmp`;
        await IOUtils.writeUTF8(temporary, JSON.stringify(payload));
        await IOUtils.move(temporary, this.file, { noOverwrite: false });
      } catch (error) {
        ztoolkit.log("partial run could not be written", error);
      }
    });
    return this.queue;
  }

  /** Forget the run: everything has been translated, or the user declined it. */
  async clear(): Promise<void> {
    this.entries.clear();
    this.dirty = false;
    await this.queue.catch(() => undefined);
    await IOUtils.remove(this.file, { ignoreAbsent: true }).catch(() => undefined);
  }
}
