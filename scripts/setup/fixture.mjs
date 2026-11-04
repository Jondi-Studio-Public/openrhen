import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A temp repo root holding a copy of the real `.env.example`, and a stdout that records writes. */
export function makeRoot() {
  const cwd = mkdtempSync(join(tmpdir(), "setup-"));
  copyFileSync(new URL("../../.env.example", import.meta.url), join(cwd, ".env.example"));
  const chunks = [];
  return { cwd, stdout: { write: (chunk) => chunks.push(String(chunk)) }, output: () => chunks.join("") };
}
