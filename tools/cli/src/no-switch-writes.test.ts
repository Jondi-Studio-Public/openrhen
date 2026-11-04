import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OWNER_ONLY_SETTINGS_FIELDS } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";

/** Add-on switches are the person's to set in the portal: no CLI or MCP command may reach the switches endpoint. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("CLI and MCP surface", () => {
  it("never calls /api/plan-map/switches", () => {
    const offenders = sources(fileURLToPath(new URL(".", import.meta.url))).filter((path) =>
      readFileSync(path, "utf8").includes("plan-map/switches")
    );
    expect(offenders).toEqual([]);
  });

  it("never names an owner-only settings field, so no command offers a way to write one (the portal refuses an agent's save anyway)", () => {
    const offenders = sources(fileURLToPath(new URL(".", import.meta.url))).filter((path) => {
      const text = readFileSync(path, "utf8");
      return OWNER_ONLY_SETTINGS_FIELDS.some((field) => text.includes(field));
    });
    expect(offenders).toEqual([]);
  });
});
