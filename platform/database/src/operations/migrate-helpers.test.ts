import { describe, expect, it } from "vitest";
import {
  CONNECT_RETRY_DELAYS_MS,
  ERROR_PART_MAX,
  MIGRATOR_CONNECTION_OPTIONS,
  MIN_FREE_BYTES_FOR_DUMP,
  describeError,
  freeSpaceProblem,
  pgEnvFromUrl,
  withRetry
} from "./migrate-helpers.js";

describe("pgEnvFromUrl", () => {
  it("splits a URL into libpq variables, decoding the credentials", () => {
    expect(pgEnvFromUrl("postgresql://app_user:p%40ss%2Fw@192.0.2.57:5432/appdb?sslmode=disable")).toEqual({
      PGHOST: "192.0.2.57",
      PGPORT: "5432",
      PGUSER: "app_user",
      PGPASSWORD: "p@ss/w",
      PGDATABASE: "appdb",
      PGSSLMODE: "disable"
    });
  });

  it("omits what the URL does not say and drops query options libpq would reject", () => {
    expect(pgEnvFromUrl("postgres://db.internal/app?max=3&connect_timeout=5")).toEqual({
      PGHOST: "db.internal",
      PGDATABASE: "app"
    });
    expect(pgEnvFromUrl("postgres://u@[::1]:55432/app?ssl=true")).toMatchObject({
      PGHOST: "::1",
      PGSSLMODE: "require"
    });
  });

  it("rejects what is not a postgres URL without echoing it", () => {
    expect(() => pgEnvFromUrl("not a url with secret")).toThrow(/valid postgres/);
    expect(() => pgEnvFromUrl("http://u:secret@host/db")).toThrow(/postgres:\/\//);
  });
});

describe("describeError", () => {
  it("keeps the wrapped Postgres error that drizzle hides behind 'Failed query'", () => {
    const cause = Object.assign(new Error("relation already exists"), { code: "42P07", detail: "in schema public" });
    const error = new Error(`Failed query: ${"CREATE TABLE x ".repeat(200)}`, { cause });
    const described = describeError(error, []);
    expect(described.cause).toBe("relation already exists");
    expect(described.code).toBe("42P07");
    expect(described.detail).toBe("in schema public");
    expect(described.message.length).toBeLessThanOrEqual(ERROR_PART_MAX + 3);
  });

  it("scrubs secrets from every part", () => {
    const cause = Object.assign(new Error("password hunter2 rejected for postgres://u:hunter2@h/db"), {
      detail: "hunter2"
    });
    const described = describeError(new Error("failed with hunter2", { cause }), [
      "postgres://u:hunter2@h/db",
      "hunter2"
    ]);
    expect(JSON.stringify(described)).not.toContain("hunter2");
    expect(described.cause).toContain("[secret]");
  });

  it("handles errors without a cause and non-errors", () => {
    expect(describeError(new Error("boom"), [])).toEqual({ message: "boom" });
    expect(describeError("plain", [])).toEqual({ message: "plain" });
  });
});

describe("withRetry", () => {
  it("returns the first success and sleeps through the configured delays between failures", async () => {
    const slept: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("down");
        return "up";
      },
      { delaysMs: [10, 20, 30], sleep: async (ms) => void slept.push(ms) }
    );
    expect(result).toBe("up");
    expect(slept).toEqual([10, 20]);
  });

  it("throws the last failure after every attempt", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error(`down ${calls}`);
        },
        { delaysMs: CONNECT_RETRY_DELAYS_MS, sleep: async () => undefined }
      )
    ).rejects.toThrow("down 5");
    expect(calls).toBe(5);
  });

  it("spans about thirty seconds", () => {
    expect(CONNECT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBe(30_000);
  });
});

describe("freeSpaceProblem", () => {
  it("passes at or above the floor and explains a shortfall", () => {
    expect(freeSpaceProblem(MIN_FREE_BYTES_FOR_DUMP)).toBeNull();
    expect(freeSpaceProblem(300 * 1024 ** 2)).toMatch(/only 300 MiB free.*1024 MiB floor/);
  });
});

describe("MIGRATOR_CONNECTION_OPTIONS", () => {
  it("bounds lock waits, statements and idle transactions on the migrator connection", () => {
    expect(MIGRATOR_CONNECTION_OPTIONS).toEqual({
      lock_timeout: 30_000,
      statement_timeout: 15 * 60_000,
      idle_in_transaction_session_timeout: 5 * 60_000
    });
  });
});
