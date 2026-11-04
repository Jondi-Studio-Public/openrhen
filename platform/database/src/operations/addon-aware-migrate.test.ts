import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addonAwareMigrator } from "./addon-aware-migrate.js";

function tree(withAddon: boolean) {
  const root = mkdtempSync(join(tmpdir(), "addon-aware-"));
  mkdirSync(join(root, "drizzle/meta"), { recursive: true });
  writeFileSync(join(root, "drizzle/meta/_journal.json"), '{"version":"7","dialect":"postgresql","entries":[]}');
  mkdirSync(join(root, "addon-drizzle/meta"), { recursive: true });
  if (withAddon)
    writeFileSync(
      join(root, "addon-drizzle/meta/_journal.json"),
      '{"version":"7","dialect":"postgresql","entries":[]}'
    );
  return root;
}

const run = async (root: string, config: Record<string, unknown>) => {
  const calls: { migrationsFolder: string; migrationsTable?: string }[] = [];
  const record = async (_db: never, c: { migrationsFolder: string }) => void calls.push(c);
  const migrator = addonAwareMigrator({ migrate: record });
  await migrator.migrate({} as never, { migrationsFolder: join(root, "drizzle"), ...config });
  return calls;
};

describe("addonAwareMigrator", () => {
  it("applies the sibling add-on set with its own ledger after core's", async () => {
    const root = tree(true);
    try {
      const calls = await run(root, {});
      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatchObject({
        migrationsFolder: join(root, "addon-drizzle"),
        migrationsTable: "__drizzle_migrations_addon"
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes through when there is no add-on journal, a custom ledger, or another folder", async () => {
    const stock = tree(false);
    const addon = tree(true);
    try {
      expect(await run(stock, {})).toHaveLength(1);
      expect(await run(addon, { migrationsTable: "custom" })).toHaveLength(1);
      expect(await run(addon, { migrationsFolder: join(addon, "addon-drizzle") })).toHaveLength(1);
    } finally {
      rmSync(stock, { recursive: true, force: true });
      rmSync(addon, { recursive: true, force: true });
    }
  });
});
