import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMIT_SENTINEL } from "@/server/cli-bundle";
import { GET as getBundle } from "./bundle/route";
import { GET as getVersion } from "./version/route";

let dir: string;
const call = (handler: typeof getBundle, path: string) =>
  handler(new Request(`http://x${path}`), { params: Promise.resolve({}) } as never);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-route-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("OPENRHEN_BUILD_COMMIT", "c9d81b2aaaaa");
  vi.stubEnv("OPENRHEN_CLI_BUNDLE_PATH", join(dir, "rhen.mjs"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("/api/cli", () => {
  it("reports the commit and bundle, and serves stamped bytes whose hash matches", async () => {
    writeFileSync(join(dir, "rhen.mjs"), `#!/usr/bin/env node\n${COMMIT_SENTINEL}\n`);
    const version = await call(getVersion, "/api/cli/version");
    expect(version.headers.get("x-openrhen-server-commit")).toBe("c9d81b2aaaaa");
    const info = (await version.json()) as { commit: string; bundle: { available: boolean; sha256: string } };
    expect(info.commit).toBe("c9d81b2aaaaa");
    expect(info.bundle.available).toBe(true);

    const bundle = await call(getBundle, "/api/cli/bundle");
    expect(bundle.headers.get("content-type")).toContain("text/javascript");
    expect(bundle.headers.get("x-bundle-sha256")).toBe(info.bundle.sha256);
    expect(await bundle.text()).toBe('#!/usr/bin/env node\n"c9d81b2aaaaa"\n');
  });

  it("answers 404 and available:false when there is no bundle", async () => {
    const version = await call(getVersion, "/api/cli/version");
    expect(await version.json()).toEqual({ commit: "c9d81b2aaaaa", bundle: { available: false } });
    expect((await call(getBundle, "/api/cli/bundle")).status).toBe(404);
  });
});
