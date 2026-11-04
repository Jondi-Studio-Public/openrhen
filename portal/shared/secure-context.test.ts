import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portal = resolve(__dirname, "..");
/** Everything that can be shipped to a browser. `app/api` only ever runs on the server. */
const clientRoots = ["features", "components", "state", "shared", "app"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "api" && dir === join(portal, "app") ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function filesNaming(api: string): string[] {
  return clientRoots
    .flatMap((root) => sourceFiles(join(portal, root)))
    .filter((file) => readFileSync(file, "utf8").includes(api))
    .map((file) => relative(portal, file).replaceAll("\\", "/"));
}

/**
 * `crypto.randomUUID` and `crypto.subtle` exist only in a secure context. The portal was reached over
 * the LAN on plain http, where both are simply absent, and each broke importing once before it moved
 * to https at openrhen.example.com. Nothing about developing surfaces it — localhost
 * *is* a secure context, so every one of these calls works here and threw there — which is why it is
 * asserted over the source rather than left to whoever reviews the next change.
 *
 * This covers our own source and nothing else. Dependencies reach the browser too: vinext's RSC
 * cache-busting calls `crypto.subtle.digest` unguarded and ships in the client bundle, and no test
 * here can see that. https retires the whole class, which is why the portal is served over it; this
 * keeps the wrappers the only route in our own code while the fallbacks are still carried.
 */
describe("secure-context APIs", () => {
  it("is reached only through the one wrapper written for it", () => {
    expect(filesNaming("crypto.randomUUID")).toEqual(["shared/client-id.ts"]);
    expect(filesNaming("crypto.subtle")).toEqual(["shared/sha256.ts"]);
  });
});
