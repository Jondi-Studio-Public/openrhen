import { describe, expect, it } from "vitest";
import { assertLoopbackTestDatabase, isLoopbackDatabaseHost } from "./loopback-test-db.js";

describe("isLoopbackDatabaseHost", () => {
  it.each([
    "postgresql://postgres:pw@localhost:5432/postgres",
    "postgresql://postgres@127.0.0.1:5432/postgres?sslmode=disable",
    "postgresql://postgres@127.0.1.1:5432/postgres",
    "postgresql://postgres@[::1]:5432/postgres",
    "postgresql://postgres@LOCALHOST/postgres",
    "postgresql:///postgres?host=/var/run/postgresql",
    "postgresql:///postgres"
  ])("accepts %s", (url) => expect(isLoopbackDatabaseHost(url)).toBe(true));

  it.each([
    "postgresql://postgres:pw@192.0.2.41:5432/postgres",
    "postgresql://postgres@db.example.com/postgres",
    "postgresql://postgres@127.0.0.1.evil.example.com/postgres",
    "postgresql://postgres@0.0.0.0/postgres",
    "postgresql:///postgres?host=192.0.2.41",
    "not a url"
  ])("rejects %s", (url) => expect(isLoopbackDatabaseHost(url)).toBe(false));

  it("checks PGHOST for a URL with no host, since the driver falls back to it", () => {
    expect(isLoopbackDatabaseHost("postgresql:///postgres", "192.0.2.41")).toBe(false);
    expect(isLoopbackDatabaseHost("postgresql:///postgres", "localhost")).toBe(true);
    expect(isLoopbackDatabaseHost("postgresql:///postgres", "/var/run/postgresql")).toBe(true);
    expect(isLoopbackDatabaseHost("postgresql://postgres@localhost/postgres", "192.0.2.41")).toBe(true);
  });
});

describe("assertLoopbackTestDatabase", () => {
  it("passes for loopback and for unset URLs", () => {
    expect(() => assertLoopbackTestDatabase({})).not.toThrow();
    expect(() =>
      assertLoopbackTestDatabase({ POSTGRES_ADMIN_URL: "postgresql://postgres@localhost:5432/postgres" })
    ).not.toThrow();
  });

  it("refuses a LAN admin URL, names the script, and does not leak credentials", () => {
    const run = () =>
      assertLoopbackTestDatabase({ POSTGRES_ADMIN_URL: "postgresql://postgres:s3cret@192.0.2.41:5432/postgres" });
    expect(run).toThrow(/start-postgres\.sh/);
    expect(run).toThrow(/192\.0\.2\.41/);
    expect(run).not.toThrow(/s3cret/);
  });

  it("refuses a LAN DATABASE_URL too", () => {
    expect(() => assertLoopbackTestDatabase({ DATABASE_URL: "postgresql://u:p@db.lan/openrhen_test" })).toThrow(
      /DATABASE_URL/
    );
  });

  it("refuses a hostless URL when PGHOST points at the LAN", () => {
    expect(() =>
      assertLoopbackTestDatabase({ POSTGRES_ADMIN_URL: "postgresql:///postgres", PGHOST: "192.0.2.41" })
    ).toThrow(/PGHOST/);
  });

  it("is overridden by ALLOW_LAN_TEST_DB=1 only", () => {
    const lan = "postgresql://postgres@192.0.2.41/postgres";
    expect(() => assertLoopbackTestDatabase({ POSTGRES_ADMIN_URL: lan, ALLOW_LAN_TEST_DB: "1" })).not.toThrow();
    expect(() => assertLoopbackTestDatabase({ POSTGRES_ADMIN_URL: lan, ALLOW_LAN_TEST_DB: "true" })).toThrow();
  });
});
