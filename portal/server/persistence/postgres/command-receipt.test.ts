import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolSql, TxSql } from "./sql-pool";

vi.mock("./ensure-user", () => ({ ensureUser: async () => "user-1" }));
const replayedState = { replayed: true };
vi.mock("./state-read", () => ({ readPortalState: async () => replayedState }));

import { claimCommandReceipt, commandRequestHash, hasCommandReceipt } from "./command-receipt";
import { CommandIdReusedError } from "./command-errors";
import { runSessionCommand } from "./session-commands";
import { saveProject } from "./project-commands";
import { endRecurrenceGoal } from "./recurrence-commands";
import { runCheckInCommand } from "./check-in-commands";

const receiptId = "6f1c2f3e-0000-4000-8000-000000000001";

/**
 * A fake postgres.js handle. `preCheck` is what the select outside the transaction finds; `claimed` is what
 * the receipt insert returns (empty when a racing twin took the receipt first, which is what `ON CONFLICT DO
 * NOTHING` reports). Every statement is recorded so a test can see what ran after the receipt.
 */
function fakeSql(options: { preCheck: { id: string }[]; claimed: { id: string }[] }) {
  const statements: string[] = [];
  const handle = (rows: (text: string) => unknown[]) =>
    ((strings: TemplateStringsArray) => {
      const text = strings.join("?");
      statements.push(text);
      return Promise.resolve(rows(text));
    }) as unknown as TxSql;
  const tx = handle((text) => (text.includes("INSERT INTO writes") ? options.claimed : []));
  const sql = Object.assign(
    handle(() => options.preCheck),
    {
      begin: async (callback: (tx: TxSql) => Promise<unknown>) => callback(tx)
    }
  ) as unknown as PoolSql;
  return { sql, tx, statements };
}

const afterReceipt = (statements: string[]) => {
  const at = statements.findIndex((text) => text.includes("INSERT INTO writes"));
  // The loser's look at the stored receipt (to compare it) is a read, not an apply.
  return at < 0 ? [] : statements.slice(at + 1).filter((text) => !text.startsWith("SELECT"));
};

describe("claimCommandReceipt", () => {
  it("claims a fresh command and leaves a conflicting one to its twin", async () => {
    const fresh = fakeSql({ preCheck: [], claimed: [{ id: receiptId }] });
    expect(await claimCommandReceipt(fresh.tx, { id: receiptId, userId: "u", commandType: "x" })).toBe(true);
    const lost = fakeSql({ preCheck: [], claimed: [] });
    expect(await claimCommandReceipt(lost.tx, { id: receiptId, userId: "u", commandType: "x" })).toBe(false);
    expect(lost.statements[0]).toContain("ON CONFLICT (id) DO NOTHING RETURNING id");
  });
});

describe("a duplicate commandId that slips past the pre-check", () => {
  beforeEach(() => vi.clearAllMocks());

  it("replays the current state instead of throwing, for every receipt-guarded command", async () => {
    const racing = () => fakeSql({ preCheck: [], claimed: [] });
    const cases: [string, (sql: PoolSql) => Promise<unknown>][] = [
      ["session", (sql) => runSessionCommand(sql, { commandId: receiptId, type: "finish" } as never)],
      ["project", (sql) => saveProject(sql, { commandId: receiptId, project: {} } as never)],
      ["recurrence", (sql) => endRecurrenceGoal(sql, { commandId: receiptId, actionId: "a" } as never)],
      ["check-in", (sql) => runCheckInCommand(sql, { commandId: receiptId, type: "answer_check_in" } as never)]
    ];
    for (const [name, run] of cases) {
      const fake = racing();
      await expect(run(fake.sql), name).resolves.toBe(replayedState);
      expect(afterReceipt(fake.statements), `${name}: nothing applied after losing the receipt`).toEqual([]);
    }
  });
});

describe("commandRequestHash", () => {
  it("ignores key order at every depth and the command id, and tells payloads and types apart", () => {
    const a = commandRequestHash("area", {
      commandId: "one",
      entity: { name: "A", nested: { x: 1, y: [1, { p: 1, q: 2 }] } }
    });
    const b = commandRequestHash("area", {
      entity: { nested: { y: [1, { q: 2, p: 1 }], x: 1 }, name: "A" },
      commandId: "two"
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(commandRequestHash("area", { entity: { name: "B" } })).not.toBe(
      commandRequestHash("area", { entity: { name: "A" } })
    );
    expect(commandRequestHash("outcome", { entity: { name: "A" } })).not.toBe(
      commandRequestHash("area", { entity: { name: "A" } })
    );
    expect(commandRequestHash("area", { entity: { name: "A", extra: undefined } })).toBe(
      commandRequestHash("area", { entity: { name: "A" } })
    );
  });
});

describe("commandRequestHash and the fields the CLI stamps from its clock", () => {
  const same = (type: string, a: object, b: object) =>
    expect(commandRequestHash(type, a)).toBe(commandRequestHash(type, b));
  const differs = (type: string, a: object, b: object) =>
    expect(commandRequestHash(type, a)).not.toBe(commandRequestHash(type, b));

  it("leaves out a recalculate's now and an ignored capture's reviewedAt", () => {
    same("recalculate", { now: "2026-10-28T01:00:00Z" }, { now: "2026-10-28T02:00:00Z" });
    differs("recalculate", { now: "a", assertedConditions: ["x"] }, { now: "a", assertedConditions: ["y"] });
    const ignore = (reviewedAt: string, proposalType = "action") => ({
      entity: { id: "c", status: "ignored", proposalType, reviewedAt }
    });
    same("capture", ignore("2026-10-28T01:00:00Z"), ignore("2026-10-28T09:00:00Z"));
    differs("capture", ignore("2026-10-28T01:00:00Z"), ignore("2026-10-28T01:00:00Z", "someday"));
  });

  it("leaves out the times a routine run and a disruption derive from now, and only for those", () => {
    const routine = (startsAt: string, title = "Morning") => ({
      entity: { id: "r", title, startsAt, endsAt: startsAt, routineSource: "preset", routinePresetId: "p" }
    });
    same("commitment", routine("2026-10-28T01:00:00Z"), routine("2026-10-28T05:00:00Z"));
    differs("commitment", routine("2026-10-28T01:00:00Z"), routine("2026-10-28T01:00:00Z", "Evening"));
    const disruption = (at: string, location = "Home") => ({
      entity: { id: "d", title: "Late", startsAt: at, endsAt: at, landedAt: at, origin: "disruption", location }
    });
    same("commitment", disruption("2026-10-28T01:00:00Z"), disruption("2026-10-28T05:00:00Z"));
    differs("commitment", disruption("2026-10-28T01:00:00Z"), disruption("2026-10-28T01:00:00Z", "Work"));
    // A hand-saved commitment's times are the caller's own choice.
    const plain = (startsAt: string) => ({ entity: { id: "p", title: "Dentist", startsAt, endsAt: startsAt } });
    differs("commitment", plain("2026-10-28T01:00:00Z"), plain("2026-10-28T05:00:00Z"));
  });
});

describe("commandRequestHash and the fields the CLI re-reads from the plan", () => {
  it("ignores the expected version, the named recommendation and a record's own version", () => {
    const update = (expectedVersion: number, version: number) => ({
      expectedVersion,
      recommendationId: `rec-${expectedVersion}`,
      entity: { id: "a", name: "Home", version }
    });
    expect(commandRequestHash("area", update(3, 3))).toBe(commandRequestHash("area", update(4, 4)));
    expect(commandRequestHash("area", { ...update(3, 3), entity: { id: "a", name: "Work", version: 3 } })).not.toBe(
      commandRequestHash("area", update(3, 3))
    );
  });
});

describe("a command id that already belongs to a different write", () => {
  const storing = (stored: { command_type: string; request_hash: string | null } | null) => {
    const select = ((strings: TemplateStringsArray) =>
      Promise.resolve(
        strings.join("?").includes("INSERT INTO writes") ? [] : stored ? [stored] : []
      )) as unknown as TxSql;
    return select;
  };
  const receipt = { id: receiptId, userId: "u", commandType: "area", requestHash: "hash-a" };

  it("replays on the same hash, and on a row from before hashes were kept", async () => {
    expect(await hasCommandReceipt(storing({ command_type: "area", request_hash: "hash-a" }), receipt)).toBe(true);
    expect(await hasCommandReceipt(storing({ command_type: "area", request_hash: null }), receipt)).toBe(true);
    expect(await hasCommandReceipt(storing(null), receipt)).toBe(false);
    expect(await claimCommandReceipt(storing({ command_type: "area", request_hash: "hash-a" }), receipt)).toBe(false);
    expect(await claimCommandReceipt(storing({ command_type: "area", request_hash: null }), receipt)).toBe(false);
  });

  it("is refused on a different hash or a different command type, in the pre-check and in the claim", async () => {
    for (const stored of [
      { command_type: "area", request_hash: "hash-b" },
      { command_type: "outcome", request_hash: null }
    ]) {
      await expect(hasCommandReceipt(storing(stored), receipt)).rejects.toBeInstanceOf(CommandIdReusedError);
      await expect(claimCommandReceipt(storing(stored), receipt)).rejects.toBeInstanceOf(CommandIdReusedError);
    }
  });
});
