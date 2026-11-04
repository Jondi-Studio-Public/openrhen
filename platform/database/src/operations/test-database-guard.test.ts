import { describe, expect, it } from "vitest";
import { assertTestDatabaseName, assertTestDatabaseUrl } from "./test-database-guard.js";

describe("assertTestDatabaseUrl", () => {
  it("accepts a database whose name ends in _test", () => {
    expect(() => assertTestDatabaseUrl("postgres://u:p@localhost:5432/openrhen_test")).not.toThrow();
    expect(() => assertTestDatabaseUrl("postgres://u:p@localhost/openrhen_r1abc_test?sslmode=disable")).not.toThrow();
  });

  it("refuses the live database and look-alikes", () => {
    expect(() => assertTestDatabaseUrl("postgres://u:p@localhost:5432/openrhen")).toThrow(/_test/);
    expect(() => assertTestDatabaseUrl("postgres://u:p@localhost/openrhen_test_backup")).toThrow(/_test/);
    expect(() => assertTestDatabaseUrl("postgres://u:p@localhost/")).toThrow(/_test/);
  });

  it("refuses a URL it cannot parse", () => {
    expect(() => assertTestDatabaseUrl("not a url")).toThrow(/valid URL/);
  });
});

describe("assertTestDatabaseName", () => {
  it("accepts a name ending in _test and refuses anything else", () => {
    expect(() => assertTestDatabaseName("openrhen_test")).not.toThrow();
    expect(() => assertTestDatabaseName("openrhen_seedsmoke123x1abc_test")).not.toThrow();
    expect(() => assertTestDatabaseName("rhen")).toThrow(/_test/);
    expect(() => assertTestDatabaseName("openrhen_test; DROP DATABASE openrhen")).toThrow(/_test/);
    expect(() => assertTestDatabaseName("")).toThrow(/_test/);
  });

  it("refuses a name Postgres would cut to 63 bytes, which would act on one without the _test", () => {
    const prefix = "p".repeat(63);
    expect(() => assertTestDatabaseName(`${prefix}_test`)).toThrow(/over 63/);
    expect(() => assertTestDatabaseName(`${"p".repeat(58)}_test`)).not.toThrow();
  });
});
