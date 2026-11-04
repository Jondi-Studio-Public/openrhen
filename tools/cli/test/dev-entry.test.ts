import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
let scratch = "";

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = "";
});

// `pnpm cli save action --from rel.json` runs this entry from tools/cli with INIT_CWD set to where the
// person typed the command; the relative path must resolve there, not inside tools/cli.
describe("dev entry (pnpm cli)", () => {
  it("resolves a relative --from path against INIT_CWD", () => {
    scratch = mkdtempSync(join(tmpdir(), "openrhen-cli-dev-"));
    writeFileSync(join(scratch, "payload.json"), "not json");
    const run = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/dev.ts", "save", "action", "--from", "payload.json", "--dry-run"],
      { cwd: packageRoot, env: { ...process.env, INIT_CWD: scratch }, encoding: "utf8" }
    );
    // Found in INIT_CWD, so it is read and rejected as JSON; from tools/cli it would be "Cannot read".
    expect(run.stderr).toContain("payload.json is not valid JSON");
    expect(run.stderr).not.toContain("Cannot read");
  });
});
