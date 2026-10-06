declare const _globalThis: {
  [key: string]: any;
  Zotero: _ZoteroTypes.Zotero;
  ztoolkit: ZToolkit;
  addon: typeof addon;
};

declare type ZToolkit = ReturnType<
  typeof import("../src/utils/ztoolkit").createZToolkit
>;

declare const ztoolkit: ZToolkit;
declare const rootURI: string;
declare const addon: import("../src/addon").default;
declare const __env__: "production" | "development";

/** Injected by zotero-plugin-scaffold from package.json `config`. */
declare const addonName: string;
declare const addonID: string;
declare const addonRef: string;
declare const addonInstance: string;
declare const prefsPrefix: string;
declare const buildVersion: string;
declare const buildTime: string;
