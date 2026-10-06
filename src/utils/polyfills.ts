/**
 * Globals the plugin sandbox does not provide but its dependencies expect.
 *
 * Zotero's `Cu.Sandbox` exposes a deliberately narrow global set, while
 * `pdfjs-dist` is written for a browser and reaches for `console`,
 * `AbortController`, `EventTarget` and friends. Two mechanisms cover the gap:
 *
 *  - `console` and `performance` are trivial to provide and are installed at
 *    module load, because a dependency may log before startup finishes.
 *  - The remaining web globals are borrowed from the Zotero main window, which
 *    is an ordinary chrome window and therefore has the full set. They are
 *    installed from `onStartup`, once a main window is guaranteed to exist.
 */

type LogFn = (...args: unknown[]) => void;

interface ConsoleLike {
  log: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  debug: LogFn;
  trace: LogFn;
  time: LogFn;
  timeEnd: LogFn;
  assert: (condition: unknown, ...args: unknown[]) => void;
  dir: LogFn;
  group: LogFn;
  groupEnd: LogFn;
}

/** Format arguments the way a browser console would, without a DOM. */
function format(args: unknown[]): string {
  return args
    .map((value) => {
      if (typeof value === "string") {
        return value;
      }
      if (value instanceof Error) {
        return value.stack ?? `${value.name}: ${value.message}`;
      }
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(" ");
}

const globals = globalThis as unknown as Record<string, unknown>;

if (typeof globals.console === "undefined") {
  const emit = (level: string): LogFn => {
    return (...args: unknown[]) => {
      try {
        Zotero.debug(`[${addonRef}/${level}] ${format(args)}`);
      } catch {
        // Logging must never be the reason a translation fails.
      }
    };
  };
  const shim: ConsoleLike = {
    log: emit("log"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    debug: emit("debug"),
    trace: emit("trace"),
    time: emit("time"),
    timeEnd: emit("timeEnd"),
    dir: emit("dir"),
    group: emit("group"),
    groupEnd: emit("groupEnd"),
    assert: (condition: unknown, ...args: unknown[]) => {
      if (!condition) {
        emit("assert")(...args);
      }
    },
  };
  globals.console = shim;
}

if (typeof globals.performance === "undefined") {
  globals.performance = {
    now: () => Date.now(),
    timeOrigin: Date.now(),
  };
}

/**
 * Web globals to borrow from the Zotero main window.
 *
 * Only names the sandbox is known to lack are listed; anything already present
 * is left alone so the sandbox's own realm keeps precedence.
 */
const BORROWED = [
  "AbortController",
  "AbortSignal",
  "Event",
  "EventTarget",
  "CustomEvent",
  "MessageEvent",
  "MessageChannel",
  "MessagePort",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "structuredClone",
  "queueMicrotask",
  "DOMException",
  "Path2D",
  "ImageData",
  "createImageBitmap",
  "OffscreenCanvas",
  "performance",
] as const;

/**
 * Copy the web globals pdf.js expects from the main window's realm.
 *
 * @returns the names that were installed, for the self-check report.
 */
export function installWebGlobals(): string[] {
  const installed: string[] = [];
  let source: Record<string, unknown> | undefined;
  try {
    source = Zotero.getMainWindow() as unknown as Record<string, unknown>;
  } catch (error) {
    Zotero.debug(`[${addonRef}] no main window to borrow globals from: ${String(error)}`);
    return installed;
  }
  if (!source) {
    return installed;
  }
  for (const name of BORROWED) {
    if (typeof globals[name] !== "undefined") {
      continue;
    }
    const value = source[name];
    if (typeof value === "undefined") {
      continue;
    }
    globals[name] = value;
    installed.push(name);
  }
  return installed;
}
