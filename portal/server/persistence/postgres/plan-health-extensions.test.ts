import { describe, expect, it } from "vitest";
import { readPlanHealthEmails, registerPlanHealthEmailSource } from "./plan-health-extensions";
import type { Sql } from "./sql-pool";

const sql = {} as Sql;
const since = new Date("2026-10-01T00:00:00.000Z");

describe("plan health email sources", () => {
  it("adds no emails until a source registers", async () => {
    expect(await readPlanHealthEmails(sql, since)).toEqual([]);
  });

  it("collects the emails of every registered source, once per id", async () => {
    const email = { id: "m1", subject: "Results", receivedAt: since, unitCodes: [] };
    registerPlanHealthEmailSource({ id: "example", read: async () => [email] });
    registerPlanHealthEmailSource({ id: "example", read: async () => [] });
    expect(await readPlanHealthEmails(sql, since)).toEqual([email]);
  });
});
