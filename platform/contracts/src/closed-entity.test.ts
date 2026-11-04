import { describe, expect, it } from "vitest";
import { CLOSED_TABLES } from "./closed-status.js";
import {
  ARCHIVE_TYPES,
  CANCEL_TYPES,
  CLOSE_TABLE_OF,
  CLOSE_TYPES,
  UNDO_VERB,
  closeBudgetRefusal,
  closedBySaveRefusal,
  closeCall,
  closedCount,
  alreadyClosedRefusal,
  ancestorClosedRefusal,
  childrenOpenRefusal,
  closeEntityCommandSchema,
  openSessionRefusal,
  reasonRequiredRefusal,
  restoreCall,
  restoreStatus,
  restoreToolFor,
  verbFor,
  wrongToolForRestoreRefusal,
  wrongVerbRefusal
} from "./closed-entity.js";
import { requiredScopes } from "./agent-scopes.js";

/**
 * Every expectation below is typed by hand from the archive-removals design (section 1) and the plan's D14 and D16
 * rules. Nothing is read back from the module under test, except that `CLOSED_TABLES` is used to prove each table is
 * covered by a type.
 */

type Verb = "archive" | "cancel" | "either" | null;

/** [type, status, what the verb table allows from an OPEN or FINISHED status]. */
const VERB_CELLS: [string, string, Verb][] = [
  ["area", "active", "archive"],
  ["area", "paused", "archive"],
  ["area", "done", "archive"],
  ["outcome", "active", "either"],
  ["outcome", "paused", "either"],
  ["outcome", "done", "archive"],
  ["project", "active", "either"],
  ["project", "paused", "either"],
  ["project", "done", "archive"],
  ...["inbox", "planned", "active", "doing", "waiting", "blocked"].map((s): [string, string, Verb] => [
    "action",
    s,
    "cancel"
  ]),
  ["action", "done", "archive"],
  ...["needs_breakdown", "ready", "in_progress", "under_review", "awaiting_result", "ready_to_complete"].map(
    (s): [string, string, Verb] => ["deliverable", s, "cancel"]
  ),
  ["deliverable", "completed", "archive"],
  ["commitment", "confirmed", "cancel"],
  ["commitment", "tentative", "cancel"],
  ["routine_preset", "active", "archive"],
  ["condition_definition", "active", "archive"]
];

describe("the closed-entity vocabulary", () => {
  it("names the eight canonical types and which verbs each takes", () => {
    expect([...CLOSE_TYPES]).toEqual([
      "area",
      "outcome",
      "project",
      "action",
      "deliverable",
      "commitment",
      "routine_preset",
      "condition_definition"
    ]);
    expect([...ARCHIVE_TYPES].sort()).toEqual(
      ["area", "outcome", "project", "action", "deliverable", "routine_preset", "condition_definition"].sort()
    );
    // area stays in the cancel enum for a restore of a legacy cancelled area only (plan D1)
    expect([...CANCEL_TYPES].sort()).toEqual(
      ["area", "outcome", "project", "action", "deliverable", "commitment"].sort()
    );
  });

  it("covers every closed table with exactly one type", () => {
    expect(new Set(Object.values(CLOSE_TABLE_OF))).toEqual(new Set(Object.keys(CLOSED_TABLES)));
    expect(Object.keys(CLOSE_TABLE_OF).sort()).toEqual([...CLOSE_TYPES].sort());
  });

  it.each(VERB_CELLS)("%s %s allows %s", (type, status, expected) => {
    expect(verbFor(type, status)).toBe(expected);
  });

  it("allows no verb on a closed row, an unknown status or an unknown type", () => {
    for (const status of ["archived", "cancelled", "nonsense"]) expect(verbFor("action", status)).toBeNull();
    expect(verbFor("commitment", "archived")).toBeNull();
    expect(verbFor("routine_preset", "archived")).toBeNull();
    expect(verbFor("plan_subject", "active")).toBeNull();
  });

  it("sends a restore to the tool whose verb matches the row's state", () => {
    expect(restoreToolFor("archived")).toBe("rhen_archive");
    expect(restoreToolFor("cancelled")).toBe("rhen_cancel");
    for (const status of ["active", "done", "completed", "confirmed", "planned"])
      expect(restoreToolFor(status)).toBeNull();
  });

  it("restores into the status the row left, with the running states made safe (D14)", () => {
    const cases: [string, string | null, string, boolean][] = [
      ["action", null, "planned", true],
      ["action", "doing", "planned", false],
      ["action", "active", "planned", false],
      ["action", "done", "done", false],
      ["action", "waiting", "waiting", false],
      ["action", "blocked", "blocked", false],
      ["action", "inbox", "inbox", false],
      ["deliverable", null, "ready", true],
      ["deliverable", "in_progress", "ready", false],
      ["deliverable", "under_review", "under_review", false],
      ["deliverable", "awaiting_result", "awaiting_result", false],
      ["deliverable", "ready_to_complete", "ready_to_complete", false],
      ["deliverable", "completed", "completed", false],
      ["commitment", null, "confirmed", true],
      ["commitment", "tentative", "tentative", false],
      ["area", null, "active", true],
      ["area", "paused", "paused", false],
      ["area", "done", "done", false],
      ["outcome", "active", "active", false],
      ["project", "paused", "paused", false],
      ["routine_preset", null, "active", true],
      ["condition_definition", "active", "active", false],
      // a recorded origin that is itself closed, or not a status of the type, cannot be a restore target
      ["area", "archived", "active", true],
      ["action", "cancelled", "planned", true],
      ["action", "confirmed", "planned", true]
    ];
    for (const [type, closedFrom, status, assumed] of cases)
      expect(restoreStatus(type, closedFrom, "archived"), `${type} from ${closedFrom}`).toEqual({ status, assumed });
  });

  it("builds the restore call from the row's own state, id and version", () => {
    expect(restoreCall("commitment", "c1", 4, "cancelled")).toEqual({
      tool: "rhen_cancel",
      arguments: { type: "commitment", id: "c1", do: "restore", "expected-version": 4 }
    });
    expect(restoreCall("area", "a1", 2, "archived")).toEqual({
      tool: "rhen_archive",
      arguments: { type: "area", id: "a1", do: "restore", "expected-version": 2 }
    });
    // a legacy cancelled area is restored by the cancel tool (D1)
    expect(restoreCall("area", "a1", 9, "cancelled").tool).toBe("rhen_cancel");
    expect(() => restoreCall("area", "a1", 9, "active")).toThrow(/not closed/);
  });
});

describe("the command schema", () => {
  const base = { type: "project", id: "p1", verb: "archive", do: "close" };

  it("takes a close with a reason and a restore with the version", () => {
    expect(closeEntityCommandSchema.parse({ ...base, reason: "finished", includeChildren: true }).includeChildren).toBe(
      true
    );
    expect(
      closeEntityCommandSchema.parse({ ...base, do: "restore", expectedVersion: 3, commandId: crypto.randomUUID() }).do
    ).toBe("restore");
  });

  it("requires do, requires the version on a restore, caps the reason and rejects unknown types and verbs", () => {
    const { do: _do, ...withoutDo } = base;
    expect(closeEntityCommandSchema.safeParse(withoutDo).success).toBe(false);
    expect(closeEntityCommandSchema.safeParse({ ...base, do: "restore" }).success).toBe(false);
    expect(closeEntityCommandSchema.safeParse({ ...base, reason: "x".repeat(501) }).success).toBe(false);
    expect(closeEntityCommandSchema.safeParse({ ...base, reason: "x".repeat(500) }).success).toBe(true);
    expect(closeEntityCommandSchema.safeParse({ ...base, type: "span" }).success).toBe(false);
    expect(closeEntityCommandSchema.safeParse({ ...base, verb: "delete" }).success).toBe(false);
    const create = crypto.randomUUID();
    expect(closeEntityCommandSchema.safeParse({ ...base, undoOfCommandId: create }).success).toBe(true);
    expect(closeEntityCommandSchema.safeParse({ ...base, undoOfCommandId: "nope" }).success).toBe(false);
    // null means "no version" and is only for an undo of a create (a forced undo from the journal)
    expect(closeEntityCommandSchema.safeParse({ ...base, expectedVersion: null }).success).toBe(false);
    expect(
      closeEntityCommandSchema.safeParse({ ...base, expectedVersion: null, undoOfCommandId: create }).success
    ).toBe(true);
    expect(
      closeEntityCommandSchema.safeParse({ ...base, undoOfCommandId: create, includeChildren: true }).success
    ).toBe(false);
    expect(
      closeEntityCommandSchema.safeParse({ ...base, do: "restore", expectedVersion: 2, undoOfCommandId: create })
        .success
    ).toBe(false);
  });
});

describe("the refusals each end in a real next call", () => {
  it("says a closed row is closed and names its restore call", () => {
    const refusal = alreadyClosedRefusal({ type: "project", id: "p1", status: "cancelled", version: 7 });
    expect(refusal.message).toContain('Project "p1"');
    expect(refusal.message).toContain("cancelled");
    expect(refusal.nextCall).toEqual({
      tool: "rhen_cancel",
      arguments: { type: "project", id: "p1", do: "restore", "expected-version": 7 },
      note: expect.any(String)
    });
  });

  it("sends an archive of an open action to cancel, and a cancel of a done one to archive", () => {
    const open = wrongVerbRefusal({ type: "action", id: "a1", status: "doing", version: 3, asked: "archive" });
    expect(open.message).toContain('Action "a1"');
    expect(open.message).toContain("open");
    expect(open.nextCall).toMatchObject({
      tool: "rhen_cancel",
      arguments: { type: "action", id: "a1", do: "close", "expected-version": 3 }
    });
    const done = wrongVerbRefusal({ type: "action", id: "a1", status: "done", version: 5, asked: "cancel" });
    expect(done.message).toContain("finished");
    expect(done.nextCall).toMatchObject({
      tool: "rhen_archive",
      arguments: { type: "action", id: "a1", do: "close", "expected-version": 5 }
    });
    const outcome = wrongVerbRefusal({ type: "outcome", id: "o1", status: "done", version: 1, asked: "cancel" });
    expect(outcome.nextCall?.tool).toBe("rhen_archive");
    const completed = wrongVerbRefusal({
      type: "deliverable",
      id: "d1",
      status: "completed",
      version: 1,
      asked: "cancel"
    });
    expect(completed.nextCall?.tool).toBe("rhen_archive");
    const appointment = wrongVerbRefusal({
      type: "commitment",
      id: "c1",
      status: "confirmed",
      version: 1,
      asked: "archive"
    });
    expect(appointment.nextCall?.tool).toBe("rhen_cancel");
    const area = wrongVerbRefusal({ type: "area", id: "ar", status: "active", version: 1, asked: "cancel" });
    expect(area.nextCall?.tool).toBe("rhen_archive");
  });

  it("sends a restore through the wrong tool to the other tool's restore call", () => {
    const refusal = wrongToolForRestoreRefusal({
      type: "area",
      id: "ar",
      status: "archived",
      version: 2,
      asked: "cancel"
    });
    expect(refusal.message).toContain("archived");
    expect(refusal.nextCall).toMatchObject({
      tool: "rhen_archive",
      arguments: { type: "area", id: "ar", do: "restore", "expected-version": 2 }
    });
    const other = wrongToolForRestoreRefusal({
      type: "action",
      id: "a1",
      status: "cancelled",
      version: 2,
      asked: "archive"
    });
    expect(other.nextCall?.tool).toBe("rhen_cancel");
  });

  it("names the open children and the same call with include-children", () => {
    const refusal = childrenOpenRefusal({
      type: "project",
      id: "p1",
      verb: "archive",
      version: 2,
      count: 3,
      deadlined: ["File taxes"]
    });
    expect(refusal.message).toContain("3 open");
    expect(refusal.message).toContain("File taxes");
    expect(refusal.nextCall).toMatchObject({
      tool: "rhen_archive",
      arguments: { type: "project", id: "p1", do: "close", "expected-version": 2, "include-children": true }
    });
  });

  it("names a closed ancestor and its restore call", () => {
    const refusal = ancestorClosedRefusal({
      type: "action",
      id: "a1",
      ancestor: { type: "project", id: "p1", status: "archived", version: 3 }
    });
    expect(refusal.message).toContain('project "p1"');
    expect(refusal.nextCall).toMatchObject({
      tool: "rhen_archive",
      arguments: { type: "project", id: "p1", do: "restore", "expected-version": 3 }
    });
  });

  it("names the open session and the call that finishes it", () => {
    const action = openSessionRefusal({ type: "action", id: "a1", sessionId: "s1", sessionTarget: "action" });
    expect(action.message).toContain("s1");
    expect(action.nextCall).toMatchObject({ tool: "rhen_session", arguments: { subcommand: "finish" } });
    const commitment = openSessionRefusal({
      type: "commitment",
      id: "c1",
      sessionId: "s2",
      sessionTarget: "fixed_commitment"
    });
    expect(commitment.nextCall).toMatchObject({ tool: "rhen_activity", arguments: { subcommand: "finish" } });
  });

  it("asks an agent for the reason with the same call plus a reason", () => {
    const refusal = reasonRequiredRefusal({ verb: "cancel", type: "commitment", id: "c1", version: 4 });
    expect(refusal.message).toContain("reason");
    expect(refusal.nextCall).toMatchObject({
      tool: "rhen_cancel",
      arguments: { type: "commitment", id: "c1", do: "close", "expected-version": 4, reason: expect.any(String) }
    });
  });
});

describe("scopes for the two tools", () => {
  it("resolves archive and cancel by the type, like save", () => {
    expect(requiredScopes({ tool: "archive", entityType: "area" })).toEqual(["write:entity:area"]);
    expect(requiredScopes({ tool: "cancel", entityType: "commitment" })).toEqual(["write:entity:commitment"]);
    expect(requiredScopes({ tool: "cancel", entityType: "condition_definition" })).toEqual([
      "write:entity:condition_definition"
    ]);
  });

  it("gives nothing for a type that has no close verb or none at all", () => {
    expect(requiredScopes({ tool: "archive", entityType: "span" })).toEqual([]);
    expect(requiredScopes({ tool: "archive", entityType: "plan_subject" })).toEqual([]);
    expect(requiredScopes({ tool: "cancel" })).toEqual([]);
  });
});

describe("the close budget vocabulary", () => {
  it("counts a ledger row as its closed figure, else the target plus its cascade", () => {
    expect(closedCount({ closed: 7 })).toBe(7);
    expect(closedCount({ cascade: [{}, {}] })).toBe(3);
    expect(closedCount({})).toBe(1);
  });

  it("refuses with what counted and a call the route then files", () => {
    const refusal = closeBudgetRefusal({
      used: 19,
      rows: 2,
      nextCall: closeCall({ verb: "cancel", type: "action", id: "a1", version: 3, reason: "x" })
    });
    expect(refusal.message).toMatch(/21 closures by agents in the last hour, over the 20 allowed/);
    expect(refusal.message).toMatch(/filed as a proposal/);
    expect(refusal.nextCall?.tool).toBe("rhen_cancel");
  });

  it("names a verb for every undoable create and leaves the deliverable out", () => {
    expect(UNDO_VERB.area).toBe("archive");
    expect(UNDO_VERB.action).toBe("cancel");
    expect(UNDO_VERB.deliverable).toBeUndefined();
  });
});

describe("the save floor refusals", () => {
  it("names the restore call for a reopen by save, by the row's own status", () => {
    const reopen = closedBySaveRefusal({
      type: "action",
      id: "a1",
      incoming: "planned",
      stored: { status: "cancelled", version: 5 }
    });
    expect(reopen.message).toMatch(/refused/);
    expect(reopen.nextCall).toMatchObject({
      tool: "rhen_cancel",
      arguments: { type: "action", id: "a1", do: "restore", "expected-version": 5 }
    });
    expect(
      closedBySaveRefusal({ type: "area", id: "x", incoming: "active", stored: { status: "archived", version: 2 } })
        .nextCall?.tool
    ).toBe("rhen_archive");
  });

  it("names the close call with the real id and version for an open row", () => {
    const refusal = closedBySaveRefusal({
      type: "action",
      id: "a1",
      incoming: "cancelled",
      stored: { status: "planned", version: 4 }
    });
    expect(refusal.message).toMatch(/refused/);
    expect(refusal.nextCall).toMatchObject({
      tool: "rhen_cancel",
      arguments: { type: "action", id: "a1", do: "close", "expected-version": 4 }
    });
    // an outcome that is done takes archive only, whatever status the save named
    expect(
      closedBySaveRefusal({ type: "outcome", id: "o1", incoming: "cancelled", stored: { status: "done", version: 2 } })
        .nextCall?.tool
    ).toBe("rhen_archive");
  });

  it("sends a closed row to its restore and a born-closed create to a plain instruction", () => {
    const moved = closedBySaveRefusal({
      type: "area",
      id: "x",
      incoming: "cancelled",
      stored: { status: "archived", version: 3 }
    });
    expect(moved.nextCall).toMatchObject({ tool: "rhen_archive", arguments: { do: "restore", "expected-version": 3 } });
    const born = closedBySaveRefusal({ type: "project", id: "p", incoming: "cancelled" });
    expect(born.nextCall).toBeUndefined();
    expect(born.message).toMatch(/Create it open/);
  });
});
