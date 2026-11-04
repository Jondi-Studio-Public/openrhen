import { describe, expect, it } from "vitest";
import { BUNDLED_DATABASE_HOST, migrateOnDeployMode } from "./migrate-skip.js";

describe("migrateOnDeployMode", () => {
  it("applies on a deploy's commit tag when unset or blank", () => {
    expect(migrateOnDeployMode(undefined, "3f2c9a1b4d7e")).toBe("apply");
    expect(migrateOnDeployMode("", "3f2c9a1b4d7e")).toBe("apply");
    expect(migrateOnDeployMode("  ", "3f2c9a1b4d7e")).toBe("apply");
  });

  it("touches nothing for a local dev image unless told to apply", () => {
    expect(migrateOnDeployMode(undefined, "dev")).toBe("local");
    expect(migrateOnDeployMode(undefined, undefined)).toBe("local");
    expect(migrateOnDeployMode("", " ")).toBe("local");
    expect(migrateOnDeployMode("apply", "dev")).toBe("apply");
  });

  it("treats anything but a 12-character commit sha as local, so a developer's own tag cannot migrate", () => {
    for (const tag of ["test1", "latest", "3f2c9a1", "3f2c9a1b4d7e0", "3F2C9A1B4D7E", "3f2c9a1b4d7g", "v1.2.3"]) {
      expect(migrateOnDeployMode(undefined, tag), tag).toBe("local");
    }
    expect(migrateOnDeployMode("apply", "test1")).toBe("apply");
  });

  it("skips on skip whatever the tag, ignoring case and padding", () => {
    expect(migrateOnDeployMode("skip", "3f2c9a1b4d7e")).toBe("skip");
    expect(migrateOnDeployMode(" SKIP ", "dev")).toBe("skip");
  });

  it("applies a dev tag against the bundled postgres host only", () => {
    expect(BUNDLED_DATABASE_HOST).toBe("postgres");
    expect(migrateOnDeployMode(undefined, "dev", "postgres")).toBe("apply");
    expect(migrateOnDeployMode("", undefined, "Postgres")).toBe("apply");
    expect(migrateOnDeployMode("skip", "dev", "postgres")).toBe("skip");
    expect(() => migrateOnDeployMode("true", "dev", "postgres")).toThrow(/MIGRATE_ON_DEPLOY/);
    for (const host of ["192.0.2.57", "localhost", "postgres.lan", "my-postgres", "", undefined]) {
      expect(migrateOnDeployMode(undefined, "dev", host), String(host)).toBe("local");
    }
  });

  it("rejects anything else rather than guessing", () => {
    expect(() => migrateOnDeployMode("true", "3f2c9a1b4d7e")).toThrow(/MIGRATE_ON_DEPLOY/);
    expect(() => migrateOnDeployMode("skp", "dev")).toThrow(/MIGRATE_ON_DEPLOY/);
  });
});
