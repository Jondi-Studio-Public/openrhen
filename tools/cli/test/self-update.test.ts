import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/build-info.js", () => ({
  buildInfo: { version: "0.1.0", commit: "c9d81b2", builtAt: null }
}));

import { runCli } from "../src/cli.js";
import { serveMcp } from "../src/commands/mcp.js";
import { selfUpdate, trustedChannel } from "../src/commands/self-update.js";
import { createClient } from "../src/client.js";
import { isBehind, staleNote } from "../src/staleness.js";
import { fixtureRawState } from "./fixture-state.js";

const NEW_BUNDLE = '#!/usr/bin/env node\nconsole.log("new");\n';
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

interface Portal {
  commit: string | null;
  bundle?: string | null;
  advertisedSha?: string;
  calls: string[];
}

function portalFetch(portal: Portal): typeof fetch {
  return async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    portal.calls.push(url.pathname);
    const headers: Record<string, string> = portal.commit ? { "x-openrhen-server-commit": portal.commit } : {};
    if (url.pathname === "/api/cli/version")
      return Response.json(
        {
          commit: portal.commit,
          bundle:
            portal.bundle == null
              ? { available: false }
              : { available: true, sha256: sha(portal.bundle), bytes: portal.bundle.length }
        },
        { headers }
      );
    if (url.pathname === "/api/cli/bundle")
      return new Response(portal.bundle ?? "", {
        headers: {
          ...headers,
          "content-type": "text/javascript",
          "x-bundle-sha256": portal.advertisedSha ?? sha(portal.bundle ?? "")
        }
      });
    if (url.pathname === "/api/state") return Response.json({ state: fixtureRawState() }, { headers });
    return Response.json({ error: "Not found" }, { status: 404, headers });
  };
}

let dir: string;
let script: string;
let staged: string;
beforeEach(() => {
  // Resolved, because macOS's temp folder is behind a symlink (/var -> /private/var) and self-update reports real paths.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "self-update-")));
  script = join(dir, "rhen.mjs");
  staged = join(dir, "rhen.new.mjs");
  writeFileSync(script, '#!/usr/bin/env node\nconsole.log("old");\n', { mode: 0o755 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function update(portal: Portal, options: { check?: boolean; scriptPath?: string; url?: string } = {}) {
  const stdout: string[] = [];
  const client = createClient({ url: options.url ?? "https://portal.test", timeoutMs: 5000 } as never, {
    fetchImpl: portalFetch(portal)
  });
  await selfUpdate(
    {
      client,
      mode: "json",
      now: () => new Date(),
      stdout: (text) => stdout.push(text),
      stderr: () => {},
      setExitCode: () => {}
    },
    { scriptPath: options.scriptPath ?? script, check: options.check ?? false }
  );
  return JSON.parse(stdout.join("\n")) as Record<string, unknown>;
}

describe("staleness note", () => {
  it("fires only when both commits are real and differ, comparing by prefix", () => {
    expect(isBehind("c9d81b2", "aaaaaaaaaaaa")).toBe(true);
    expect(isBehind("c9d81b2", "c9d81b2eeeee")).toBe(false);
    expect(isBehind("c9d81b2eeeee", "c9d81b2")).toBe(false);
    for (const unknown of [null, undefined, "", "dev", "unknown"]) expect(isBehind("c9d81b2", unknown)).toBe(false);
    expect(isBehind("dev", "aaaaaaaaaaaa")).toBe(false);
    expect(staleNote("aaaaaaaaaaaa")).toBe(
      "Note: this CLI build (c9d81b2) differs from the portal (aaaaaaaaaaaa). Run `rhen self-update` to update."
    );
  });

  async function run(commit: string | null, argv: string[] = ["status", "--json"]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(argv, {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      env: {},
      readConfigFile: () => null,
      fetchImpl: portalFetch({ commit, calls: [] })
    });
    return { exitCode, stdout: stdout.join("\n"), stderr };
  }

  it("writes one stderr line when behind, leaving stdout and the exit code alone", async () => {
    const behind = await run("aaaaaaaaaaaa");
    expect(behind.exitCode).toBe(0);
    expect(() => JSON.parse(behind.stdout)).not.toThrow();
    expect(behind.stderr).toHaveLength(1);
    expect(behind.stderr[0]).toContain("differs from the portal (aaaaaaaaaaaa)");
  });

  it("stays quiet when equal, prefix-equal, or the portal commit is unknown", async () => {
    for (const commit of ["c9d81b2", "c9d81b2eeeee", null]) expect((await run(commit)).stderr).toEqual([]);
  });
});

describe("self-update", () => {
  it("replaces the bundle atomically, keeps a .bak, and keeps the file mode", async () => {
    const result = await update({ commit: "aaaaaaaaaaaa", bundle: NEW_BUNDLE, calls: [] });
    expect(result).toMatchObject({
      status: "updated",
      from: "c9d81b2",
      to: "aaaaaaaaaaaa",
      bytes: NEW_BUNDLE.length,
      backupPath: `${script}.bak`
    });
    expect(String(result.note)).toContain("restarts it");
    expect(readFileSync(script, "utf8")).toBe(NEW_BUNDLE);
    expect(readFileSync(`${script}.bak`, "utf8")).toContain("old");
    expect(existsSync(staged)).toBe(false);
    expect(statSync(script).mode & 0o777).toBe(0o755);
  });

  it("says so and writes nothing when already up to date", async () => {
    const portal = { commit: "c9d81b2eeeee", bundle: NEW_BUNDLE, calls: [] as string[] };
    expect(await update(portal)).toMatchObject({ status: "up-to-date" });
    expect(portal.calls).toEqual(["/api/cli/version"]);
    expect(readFileSync(script, "utf8")).toContain("old");
  });

  it("--check reports without downloading or writing", async () => {
    const portal = { commit: "aaaaaaaaaaaa", bundle: NEW_BUNDLE, calls: [] as string[] };
    expect(await update(portal, { check: true })).toMatchObject({ status: "update-available", written: false });
    expect(portal.calls).toEqual(["/api/cli/version"]);
    expect(readFileSync(script, "utf8")).toContain("old");
    expect(existsSync(`${script}.bak`)).toBe(false);
  });

  it("rejects a sha256 mismatch and leaves the script untouched", async () => {
    await expect(
      update({ commit: "aaaaaaaaaaaa", bundle: NEW_BUNDLE, advertisedSha: "0".repeat(64), calls: [] })
    ).rejects.toThrow(/sha256/);
    expect(readFileSync(script, "utf8")).toContain("old");
    expect(existsSync(staged)).toBe(false);
  });

  it("refuses a bundle that passes sha and banner but fails to start, and removes the staged file", async () => {
    const broken = '#!/usr/bin/env node\nthrow new Error("boom");\n';
    await expect(update({ commit: "aaaaaaaaaaaa", bundle: broken, calls: [] })).rejects.toThrow(/failed to start/);
    expect(readFileSync(script, "utf8")).toContain("old");
    expect(existsSync(staged)).toBe(false);
    expect(existsSync(`${script}.bak`)).toBe(false);
  });

  it("removes the staged file when the swap itself fails", async () => {
    mkdirSync(`${script}.bak`);
    await expect(update({ commit: "aaaaaaaaaaaa", bundle: NEW_BUNDLE, calls: [] })).rejects.toThrow();
    expect(readFileSync(script, "utf8")).toContain("old");
    expect(existsSync(staged)).toBe(false);
  });

  it("rejects a download without the node banner", async () => {
    await expect(update({ commit: "aaaaaaaaaaaa", bundle: "<html>login</html>", calls: [] })).rejects.toThrow(/banner/);
    expect(readFileSync(script, "utf8")).toContain("old");
  });

  it("errors clearly when the portal has no bundle", async () => {
    await expect(update({ commit: "aaaaaaaaaaaa", bundle: null, calls: [] })).rejects.toThrow(/no CLI bundle/);
  });

  it("refuses to download over plain http to the LAN, before fetching the bundle", async () => {
    const portal = { commit: "aaaaaaaaaaaa", bundle: NEW_BUNDLE, calls: [] as string[] };
    await expect(update(portal, { url: "http://portal.example.com:8787" })).rejects.toThrow(/HTTPS/);
    expect(portal.calls).toEqual(["/api/cli/version"]);
    expect(readFileSync(script, "utf8")).toContain("old");
  });

  it("still reports over plain http with --check, since nothing is downloaded", async () => {
    const portal = { commit: "aaaaaaaaaaaa", bundle: NEW_BUNDLE, calls: [] as string[] };
    expect(await update(portal, { check: true, url: "http://portal.example.com:8787" })).toMatchObject({
      status: "update-available"
    });
  });

  it("starts the staged bundle with no token or other environment", async () => {
    const seen = join(dir, "seen-env.json");
    const probe = `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env));\n`;
    const previous = process.env.OPENRHEN_TOKEN;
    process.env.OPENRHEN_TOKEN = "agent-token-DUMMY";
    try {
      await update({ commit: "aaaaaaaaaaaa", bundle: probe, calls: [] });
    } finally {
      if (previous === undefined) delete process.env.OPENRHEN_TOKEN;
      else process.env.OPENRHEN_TOKEN = previous;
    }
    const env = JSON.parse(readFileSync(seen, "utf8")) as Record<string, string>;
    expect(env.OPENRHEN_TOKEN).toBeUndefined();
    // macOS's CoreFoundation sets __CF_USER_TEXT_ENCODING in every process it starts, whatever env it is given.
    const allowed = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "__CF_USER_TEXT_ENCODING"];
    expect(Object.keys(env).filter((name) => !allowed.includes(name))).toEqual([]);
  });

  it("trusts only https or this machine as a download channel", () => {
    expect(trustedChannel("https://openrhen.example.com")).toBe(true);
    expect(trustedChannel("http://127.0.0.1:8787")).toBe(true);
    expect(trustedChannel("http://localhost:8787")).toBe(true);
    expect(trustedChannel("http://portal.example.com:8787")).toBe(false);
    expect(trustedChannel("http://box.tail1234.ts.net")).toBe(false);
    // A name that merely starts like a loopback address is a name, resolved by DNS.
    expect(trustedChannel("http://127.portal.internal")).toBe(false);
    expect(trustedChannel("http://127.0.0.1.attacker.example")).toBe(false);
    expect(trustedChannel("http://[::1]:8787")).toBe(true);
  });

  it("refuses to run from source", async () => {
    await expect(
      update({ commit: "aaaaaaaaaaaa", bundle: NEW_BUNDLE, calls: [] }, { scriptPath: join(dir, "main.ts") })
    ).rejects.toThrow(/git pull/);
  });

  it("is a registered command that works with --read-only and does not warn about itself", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(["self-update", "--check", "--read-only", "--json"], {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      env: {},
      readConfigFile: () => null,
      fetchImpl: portalFetch({ commit: "aaaaaaaaaaaa", bundle: NEW_BUNDLE, calls: [] })
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ status: "update-available", written: false });
    expect(stderr).toEqual([]);
  });
});

describe("MCP", () => {
  async function mcp(commit: string, lines: object[]) {
    const written: string[] = [];
    await serveMcp({
      input: lines.map((line) => JSON.stringify({ jsonrpc: "2.0", ...line })),
      write: (line) => written.push(line),
      runner: (argv, capture) =>
        runCli(argv, { ...capture, env: {}, readConfigFile: () => null, fetchImpl: portalFetch({ commit, calls: [] }) })
    });
    return written.map((line) => JSON.parse(line) as { result: Record<string, unknown> });
  }

  it("reports the build commit in serverInfo.version", async () => {
    const [init] = await mcp("c9d81b2", [{ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }]);
    expect(init?.result.serverInfo).toMatchObject({ version: "0.1.0+c9d81b2" });
  });

  it("surfaces the staleness note in the Notes from the CLI block", async () => {
    const out = await mcp("aaaaaaaaaaaa", [
      { id: 2, method: "tools/call", params: { name: "rhen_status", arguments: {} } }
    ]);
    const content = out[0]?.result.content as { text: string }[];
    expect(content.at(-1)?.text).toMatch(
      /^Notes from the CLI:\nNote: this CLI build \(c9d81b2\) differs from the portal/
    );
  });
});
