import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The server and client module graphs are separate, so an extension registered only from the layout never reaches the
// browser. Whatever reads the registry must import it through `state/extensions`, which loads the seam
// first; only an extension itself (which the seam loads) and a test that registers its own may import the registry.
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".next" || name === "dist") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("the portal extension registry", () => {
  it("is read only through the module that loads the seam", () => {
    const root = resolve(process.cwd());
    // The feature folders the seam loads: an extension and the pieces it owns import the registry directly.
    const owned = [
      ...readFileSync(join(root, "state/private/index.ts"), "utf8").matchAll(/"@\/(features\/[^/]+)\//g)
    ].map((match) => `${match[1]}/`);
    const offenders = sources(root)
      .filter((path) => !/\.test\.tsx?$/.test(path))
      .filter((path) => /from "(@\/state\/portal-extensions|\.\/portal-extensions)"/.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(root.length + 1))
      .filter(
        (path) =>
          path !== "state/extensions.ts" &&
          // An extension, and the pieces it owns, import the registry directly: the seam loads them.
          !owned.some((folder) => path.startsWith(folder)) &&
          path !== "state/private/index.ts" &&
          // The stand-in mail source registers itself from a test.
          !path.startsWith("test/")
      );
    expect(offenders).toEqual([]);
  });
});
