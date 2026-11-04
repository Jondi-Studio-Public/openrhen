import { describe, expect, it } from "vitest";
import { assertLocalUrl, assertSeedDatabaseUrl } from "./demo-guard.js";

describe("demo seed guard", () => {
  it("accepts loopback hosts", () => {
    expect(assertLocalUrl("http://localhost:5173", "portal").port).toBe("5173");
    expect(assertLocalUrl("http://127.0.0.1:5175", "portal").hostname).toBe("127.0.0.1");
    expect(assertLocalUrl("postgresql://postgres@localhost:5432/openrhen?sslmode=disable", "database").pathname).toBe(
      "/openrhen"
    );
  });

  it("refuses anything that is not this machine", () => {
    for (const url of [
      "http://192.0.2.41:8787",
      "https://openrhen.example.com",
      "http://localhost.evil.example:5173",
      "http://0.0.0.0:5173",
      "postgresql://postgres@192.0.2.57:5432/openrhen"
    ])
      expect(() => assertLocalUrl(url, "portal")).toThrow(/Refusing to seed/);
    expect(() => assertLocalUrl("not a url", "portal")).toThrow(/not a valid URL/);
  });

  it("seeds a database on this machine, or only a _test one on the LAN Postgres", () => {
    expect(assertSeedDatabaseUrl("postgresql://postgres@localhost:5432/openrhen", "database").hostname).toBe(
      "localhost"
    );
    expect(
      assertSeedDatabaseUrl("postgresql://u:p@10.20.30.57:5432/openrhen_seedsmoke1x1_test", "database").hostname
    ).toBe("10.20.30.57");
    expect(() => assertSeedDatabaseUrl("postgresql://u:p@10.20.30.57:5432/openrhen", "database")).toThrow(
      /only a _test database/
    );
    expect(() => assertSeedDatabaseUrl("postgresql://u:p@db.example.com:5432/openrhen_test", "database")).toThrow(
      /not localhost or the LAN/
    );
    expect(() => assertSeedDatabaseUrl("postgresql://u:p@172.32.0.1:5432/openrhen_test", "database")).toThrow(
      /not localhost or the LAN/
    );
  });
});
