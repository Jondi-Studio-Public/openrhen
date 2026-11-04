import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { connectionRegistry } from "@openrhen/contracts";

describe("connection manifests", () => {
  it("cover every provider env name the code reads today", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const read = new Set<string>();
    // Each registered connection's id is its env prefix (EXAMPLE_SHARED_ ...), beside the shared names.
    const own = connectionRegistry().map((manifest) => manifest.id.toUpperCase());
    const prefix = new RegExp(
      `^(${[...own, "CALENDAR_SYNC", "GOOGLE_CALENDAR", "GOOGLE_MAPS", "PULSE_PUBLISH", "OPENAI", "DEEPINFRA"].join("|")})_`
    );
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", "dist", "build", ".next", "var", ".git"].includes(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !path.includes("/connections/")) {
          for (const m of readFileSync(path, "utf8").matchAll(/(?:process\.)?env\.([A-Z][A-Z0-9_]*)/g)) {
            if (prefix.test(m[1]!)) read.add(m[1]!);
          }
        }
      }
    };
    for (const dir of ["engine", "portal", "integrations", "platform", "tools"]) walk(join(root, dir));
    const declared = new Set(
      connectionRegistry().flatMap((c) => [...c.secrets.anyOf.flat(), ...Object.keys(c.config)])
    );
    expect([...read].filter((name) => !declared.has(name))).toEqual([]);
  });
});
