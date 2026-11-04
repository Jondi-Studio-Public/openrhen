import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureIntegrationDbSuffix,
  integrationDatabaseName,
  integrationRoleName,
  takeTrackedIntegrationNames
} from "./integration-database.js";

const originalEnv = {
  INTEGRATION_DB_SUFFIX: process.env.INTEGRATION_DB_SUFFIX,
  INTEGRATION_DB_SUFFIX_MINTED: process.env.INTEGRATION_DB_SUFFIX_MINTED
};

beforeEach(() => {
  delete process.env.INTEGRATION_DB_SUFFIX;
  delete process.env.INTEGRATION_DB_SUFFIX_MINTED;
  takeTrackedIntegrationNames();
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("integrationDatabaseName", () => {
  it("returns the pinned name untouched", () => {
    process.env.INTEGRATION_DB_SUFFIX = "r1abc";
    expect(integrationDatabaseName("openrhen_test", "openrhen_state_store")).toBe("openrhen_test");
  });

  it("appends only _test when no run suffix was minted", () => {
    expect(integrationDatabaseName(undefined, "openrhen_state_store")).toBe("openrhen_state_store_test");
  });

  it("places the run suffix between the base and _test", () => {
    process.env.INTEGRATION_DB_SUFFIX = "r1abc";
    expect(integrationDatabaseName(undefined, "openrhen_state_store")).toBe("openrhen_state_store_r1abc_test");
  });

  it("refuses a suffix that is not a plain lowercase identifier", () => {
    process.env.INTEGRATION_DB_SUFFIX = "Bad-Suffix";
    expect(() => integrationDatabaseName(undefined, "rhen")).toThrow(/INTEGRATION_DB_SUFFIX/);
  });
});

describe("integrationRoleName", () => {
  it("names a per-run role the same way as a per-run database, so the run's teardown drops both", () => {
    process.env.INTEGRATION_DB_SUFFIX = "r1abc";
    expect(integrationRoleName(undefined, "other_service")).toBe("other_service_r1abc_test");
    expect(integrationRoleName("other_service_pinned_test", "other_service")).toBe("other_service_pinned_test");
  });
});

describe("ensureIntegrationDbSuffix", () => {
  it("mints a suffix once and reports null when one is already present", () => {
    const minted = ensureIntegrationDbSuffix();
    expect(minted).toMatch(/^r[a-z0-9]+$/);
    expect(process.env.INTEGRATION_DB_SUFFIX).toBe(minted);
    expect(ensureIntegrationDbSuffix()).toBeNull();
  });
});

describe("takeTrackedIntegrationNames", () => {
  it("returns the names minted for this run once, so each test file drops only its own", () => {
    ensureIntegrationDbSuffix();
    const name = integrationDatabaseName(undefined, "openrhen_state_store");
    const role = integrationRoleName(undefined, "other_service");
    expect(takeTrackedIntegrationNames().sort()).toEqual([role, name].sort());
    expect(takeTrackedIntegrationNames()).toEqual([]);
  });

  it("never tracks a pinned name or a suffix the caller supplied, whose cleanup is the caller's", () => {
    process.env.INTEGRATION_DB_SUFFIX = "r1abc";
    integrationDatabaseName(undefined, "openrhen_state_store");
    process.env.INTEGRATION_DB_SUFFIX_MINTED = "r1abc";
    integrationDatabaseName("openrhen_test", "openrhen_state_store");
    expect(takeTrackedIntegrationNames()).toEqual([]);
  });
});
