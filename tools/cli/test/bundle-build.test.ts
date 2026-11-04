import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `GET /api/cli/bundle` serves the built CLI to anyone who can reach the portal (it is public by design), so
 * the build must bake in nothing but the version, commit and build time. Anything else in `define` would be
 * an inlined value; reading `process.env` at run time is fine, as the bundle holds the code, not the values.
 */
describe("the CLI bundle build", () => {
  const script = readFileSync(new URL("../scripts/build.mjs", import.meta.url), "utf8");

  it("defines only the version, commit and build time", () => {
    const block = /define:\s*\{([^}]*)\}/.exec(script)?.[1] ?? "";
    const keys = [...block.matchAll(/^\s*(\w+):/gm)].map((match) => match[1]);
    expect(keys).toEqual(["__OPENRHEN_VERSION__", "__OPENRHEN_COMMIT__", "__OPENRHEN_BUILT_AT__"]);
    expect(block).not.toMatch(/process\.env/);
  });

  it("does not bundle a dotenv loader or read the environment at build time into the output", () => {
    expect(script).not.toMatch(/dotenv/);
    expect(script.match(/process\.env\.\w+/g)).toEqual(["process.env.OPENRHEN_BUILD_COMMIT"]);
  });
});
