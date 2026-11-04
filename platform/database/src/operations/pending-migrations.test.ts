import { describe, expect, it } from "vitest";
import journal from "../../drizzle/meta/_journal.json" with { type: "json" };
import {
  imageNewestMigration,
  pendingMigrationTags,
  pendingTagsAfter,
  schemaAheadProblem
} from "./pending-migrations.js";

const entries = journal.entries;
const latest = entries[entries.length - 1]!;

describe("pendingMigrationTags", () => {
  it("lists nothing when the latest journal migration is applied", async () => {
    expect(await pendingMigrationTags(async () => [{ last: String(latest.when) }])).toEqual([]);
  });

  it("lists the migrations newer than the latest applied one", async () => {
    // The migration two before the latest where the journal has that many (the full history); in the baseline
    // export the journal has one entry, so the database sits just behind it and that one is pending.
    const full = entries.length >= 3;
    const applied = full ? entries[entries.length - 3]!.when : latest.when - 1;
    expect(await pendingMigrationTags(async () => [{ last: String(applied) }])).toEqual(
      (full ? entries.slice(-2) : [latest]).map((entry) => entry.tag)
    );
  });

  it("lists every migration when the migrations table does not exist", async () => {
    const missing = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    expect(
      await pendingMigrationTags(async () => {
        throw missing;
      })
    ).toHaveLength(entries.length);
  });

  it("rethrows any other database error", async () => {
    await expect(
      pendingMigrationTags(async () => {
        throw new Error("connection refused");
      })
    ).rejects.toThrow("connection refused");
  });
});

describe("schemaAheadProblem", () => {
  it("accepts a database at or behind the image", () => {
    expect(schemaAheadProblem(latest.when, latest.when)).toBeNull();
    expect(schemaAheadProblem(latest.when - 1, latest.when)).toBeNull();
    expect(schemaAheadProblem(0, latest.when)).toBeNull();
  });

  it("refuses a database ahead of the image and says how to recover", () => {
    const message = schemaAheadProblem(latest.when + 1, latest.when);
    expect(message).toContain("ahead of this image");
    expect(message).toContain("Roll forward");
    expect(message).toContain("pre-migrate dump");
    expect(message).toContain("MIGRATE_ON_DEPLOY=skip");
  });

  it("uses the newest journal entry as the image's position", () => {
    expect(imageNewestMigration()).toBe(Math.max(...entries.map((entry) => entry.when)));
  });
});

describe("pendingTagsAfter", () => {
  it("matches pendingMigrationTags for the same position", async () => {
    const applied = entries.length >= 3 ? entries[entries.length - 3]!.when : latest.when - 1;
    expect(pendingTagsAfter(applied)).toEqual(await pendingMigrationTags(async () => [{ last: String(applied) }]));
  });
});
