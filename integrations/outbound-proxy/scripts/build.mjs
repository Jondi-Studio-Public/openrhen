#!/usr/bin/env node
// Bundles the proxy with esbuild: one file per entry in `dist/`, named after the entry (the Dockerfile copies them).
//
// A drop-in may also ship a command-line tool: every `src/drop-ins/<name>/bin/*.ts` is bundled to `dist/<basename>.js`
// beside `main.js`, and the image copies the whole of `dist/`, so a build without that drop-in has nothing to copy.
//
// `src/drop-ins.ts` lists a folder at run time, which a bundle cannot do, so the build swaps it for one static
// import per `src/drop-ins/<name>/register.ts` present now. A folder that is not on disk is simply not in the bundle.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dropInsRoot = join(packageDir, "src", "drop-ins");
const binEntries = (existsSync(dropInsRoot) ? readdirSync(dropInsRoot).sort() : []).flatMap((name) => {
  const bin = join(dropInsRoot, name, "bin");
  return existsSync(bin)
    ? readdirSync(bin)
        .sort()
        .filter((file) => file.endsWith(".ts"))
        .map((file) => `./src/drop-ins/${name}/bin/${file}`)
    : [];
});
// An entry map, so each output lands flat at `dist/<name>.js` whatever folder its source sits in.
const entryPoints = Object.fromEntries([
  ["main", "./src/main.ts"],
  // The calendar feed parser runs in a worker thread; the Dockerfile copies all of `dist/`, so it sits beside `main.js`.
  ["calendar-feed-worker", "./src/connections/calendar-feed/worker.ts"],
  ...binEntries.map((entry) => [entry.split("/").pop().replace(/\.ts$/, ""), entry])
]);

const dropIns = {
  name: "drop-ins",
  setup(esbuild) {
    esbuild.onLoad({ filter: /[\\/]src[\\/]drop-ins\.ts$/ }, () => {
      const names = existsSync(dropInsRoot) ? readdirSync(dropInsRoot).sort() : [];
      const present = names.filter((name) => existsSync(join(dropInsRoot, name, "register.ts")));
      return {
        loader: "ts",
        resolveDir: join(packageDir, "src"),
        contents: `${present.map((name) => `import "./drop-ins/${name}/register.ts";`).join("\n")}\nexport const loadedDropIns: string[] = ${JSON.stringify(present)};\n`
      };
    });
  }
};

await build({
  entryPoints,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outdir: "./dist",
  absWorkingDir: packageDir,
  plugins: [dropIns]
});
