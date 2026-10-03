// Bundle the Node side (server + Electron main) with esbuild.
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: ["electron", "node:sqlite"],
  banner: {
    // Some CJS dependencies call require(); give ESM bundles one.
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "info",
};

await build({ ...common, entryPoints: ["src/server/main.ts"], outfile: "dist/server/main.mjs" });
await build({ ...common, entryPoints: ["src/electron/main.ts"], outfile: "dist/electron/main.mjs" });
