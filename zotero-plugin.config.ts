import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  // No update server is published, so the manifest carries no update_url: an
  // unreachable one only makes Zotero retry a check that can never succeed.

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV ?? "production"}"`,
          // `build.define` below only substitutes `__placeholder__` tokens in
          // the packaged assets; the bundled script needs real literals.
          addonName: JSON.stringify(pkg.config.addonName),
          addonID: JSON.stringify(pkg.config.addonID),
          addonRef: JSON.stringify(pkg.config.addonRef),
          addonInstance: JSON.stringify(pkg.config.addonInstance),
          prefsPrefix: JSON.stringify(pkg.config.prefsPrefix),
          buildVersion: JSON.stringify(pkg.version),
        },
        bundle: true,
        // Zotero 10 is built on mozilla-esr140 (verified against the installed
        // D:\Zotero\platform.ini, BuildID 20260826142222).
        target: "firefox140",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  server: {
    devtools: false,
    createProfileIfMissing: true,
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});
