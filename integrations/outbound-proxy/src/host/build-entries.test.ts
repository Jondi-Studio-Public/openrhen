import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// esbuild names each output after its entry's basename. The image copies the whole of `dist/`, so a drop-in's
// command-line tool needs no Dockerfile line and a build without that drop-in has nothing to copy. This pins both ends.
const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const build = readFileSync(join(packageDir, "scripts", "build.mjs"), "utf8");
const dropInsRoot = join(packageDir, "src", "drop-ins");
const binEntries = (existsSync(dropInsRoot) ? readdirSync(dropInsRoot).sort() : []).flatMap((name) => {
  const bin = join(dropInsRoot, name, "bin");
  return existsSync(bin)
    ? readdirSync(bin)
        .filter((file) => file.endsWith(".ts"))
        .map((file) => `./src/drop-ins/${name}/bin/${file}`)
    : [];
});

describe("proxy build entries", () => {
  it("bundles main.ts, the calendar feed worker and every drop-in bin, and names no provider entry itself", () => {
    expect([...build.matchAll(/"(\.\/src\/[^"\s]+\.ts)"/g)].map((match) => match[1])).toEqual([
      "./src/main.ts",
      "./src/connections/calendar-feed/worker.ts"
    ]);
    expect(build).toContain("drop-ins/${name}/bin/");
  });

  it("has every drop-in bin entry on disk with a distinct output name", () => {
    for (const entry of binEntries) expect(existsSync(join(packageDir, entry)), entry).toBe(true);
    const names = binEntries.map((entry) => basename(entry, ".ts"));
    expect(new Set(names).size).toBe(names.length);
  });

  it("copies the whole dist directory and starts main.js", () => {
    const dockerfile = readFileSync(join(packageDir, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/COPY --from=build \S+\/outbound-proxy\/dist \.\/\n/);
    expect(dockerfile).toContain('CMD ["node", "main.js"]');
  });

  it("writes every entry flat to dist/<name>.js, so a documented `node <tool>.js` still works", () => {
    // The entry map names the outputs; an array of paths would keep the source folders under dist/.
    expect(build).toMatch(/const entryPoints = Object\.fromEntries\(/);
    expect(build).toContain('["main", "./src/main.ts"]');
    expect(build).toContain('["calendar-feed-worker", "./src/connections/calendar-feed/worker.ts"]');
    const outputs = ["main", "calendar-feed-worker", ...binEntries.map((entry) => basename(entry, ".ts"))];
    expect(outputs.every((name) => /^[\w-]+$/.test(name))).toBe(true);
    for (const name of outputs) expect(name).not.toContain("/");
  });
});
