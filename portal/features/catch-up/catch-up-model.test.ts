import { describe, expect, it } from "vitest";
import type { CatchUpEntry, CatchUpLedger } from "@openrhen/contracts";
import {
  EMPTY_DECISIONS,
  applyToEntries,
  buildSettleCommand,
  choicesFor,
  decidedEntries,
  groupEntries,
  localInputToInstant,
  pruneDecisions,
  setChoice,
  setMoveTo,
  showBanner
} from "./catch-up-model";

const ZONE = "Australia/Sydney";
const COMMAND_ID = "11111111-1111-4111-8111-111111111111";

function entry(overrides: Partial<CatchUpEntry> & Pick<CatchUpEntry, "id">): CatchUpEntry {
  return {
    question: null,
    verdicts:
      overrides.kind === "external_deadline"
        ? ["done", "dropped", "pending"]
        : ["done", "skipped", "dropped", "pending"],
    atRequired: [],
    kind: "occurrence",
    title: "Stretch",
    plannedAt: "2026-10-16T10:00:00.000Z",
    localDate: "2026-10-16",
    projectId: "p1",
    version: null,
    ...overrides
  };
}

function ledger(overrides: Partial<CatchUpLedger> = {}): CatchUpLedger {
  return {
    now: "2026-10-18T12:00:00.000Z",
    since: "2026-10-13T02:00:00.000Z",
    due: true,
    unsettled: 14,
    staleDates: 2,
    nextOffset: null,
    entries: [],
    remaining: 0,
    ...overrides
  };
}

describe("groupEntries", () => {
  it("groups by day newest first, then by project", () => {
    const days = groupEntries(
      [
        entry({ id: "occurrence:a", localDate: "2026-10-15", projectId: "p1" }),
        entry({ id: "occurrence:b", localDate: "2026-10-16", projectId: "p2" }),
        entry({ id: "occurrence:c", localDate: "2026-10-16", projectId: "p1" }),
        entry({ id: "occurrence:d", localDate: "2026-10-16", projectId: "p2" })
      ],
      ZONE
    );
    expect(days.map((day) => day.day)).toEqual(["2026-10-16", "2026-10-15"]);
    expect(days[0]!.projects.map((project) => project.entries.map((item) => item.id))).toEqual([
      ["occurrence:b", "occurrence:d"],
      ["occurrence:c"]
    ]);
  });

  it("places a deadline on the local day it lapsed", () => {
    const days = groupEntries(
      [entry({ id: "deadline:p", kind: "self_set_deadline", localDate: null, plannedAt: "2026-10-16T20:00:00.000Z" })],
      ZONE
    );
    expect(days[0]!.day).toBe("2026-10-17");
  });
});

describe("choices", () => {
  it("offers no skip for an external date", () => {
    expect(choicesFor("external_deadline")).not.toContain("skipped");
    expect(choicesFor("self_set_deadline")).toContain("skipped");
  });

  it("applies a bulk choice only where it is offered", () => {
    const entries = [
      entry({ id: "occurrence:a" }),
      entry({ id: "deadline:x", kind: "external_deadline", localDate: null })
    ];
    const next = applyToEntries(EMPTY_DECISIONS, entries, "skipped");
    expect(next.choices).toEqual({ "occurrence:a": "skipped" });
  });

  it("counts Keep open as a decision only when it moves a date", () => {
    const entries = [entry({ id: "deadline:x", kind: "self_set_deadline", localDate: null, version: 3 })];
    const open = setChoice(EMPTY_DECISIONS, "deadline:x", "pending");
    expect(decidedEntries(open, entries)).toEqual([]);
    expect(decidedEntries(setMoveTo(open, "deadline:x", "2026-11-01"), entries)).toHaveLength(1);
  });

  it("forgets decisions about entries the ledger no longer lists", () => {
    const decisions = setChoice(setChoice(EMPTY_DECISIONS, "occurrence:a", "done"), "occurrence:gone", "done");
    expect(pruneDecisions(decisions, [entry({ id: "occurrence:a" })]).choices).toEqual({ "occurrence:a": "done" });
  });
});

describe("buildSettleCommand", () => {
  it("is null when nothing is decided", () => {
    expect(buildSettleCommand(EMPTY_DECISIONS, [entry({ id: "occurrence:a" })], opts())).toBeNull();
  });

  it("sends verdicts with the version a deadline was read at and the person's note", () => {
    const entries = [
      entry({ id: "occurrence:a" }),
      entry({ id: "deadline:p", kind: "self_set_deadline", localDate: null, version: 4 }),
      entry({ id: "deadline:q", kind: "self_set_deadline", localDate: null, version: 2 })
    ];
    let decisions = setChoice(EMPTY_DECISIONS, "occurrence:a", "done");
    decisions = setChoice(decisions, "deadline:p", "dropped");
    decisions = setMoveTo(setChoice(decisions, "deadline:q", "pending"), "deadline:q", "2026-11-01");
    const command = buildSettleCommand({ ...decisions, note: "  Went away for the weekend  " }, entries, opts())!;
    expect(command.verdicts).toEqual([
      { entryId: "occurrence:a", verdict: "done" },
      { entryId: "deadline:p", verdict: "dropped", version: 4, becomes: "paused" },
      { entryId: "deadline:q", verdict: "pending", version: 2, moveTo: expect.stringMatching(/^2026-1[01]-\d\dT/) }
    ]);
    expect(command.note).toBe("Went away for the weekend");
    expect(command.closeWindow).toBe(false);
  });

  function opts(closeWindow = false) {
    return { commandId: COMMAND_ID, timezone: ZONE, closeWindow };
  }
});

describe("banner", () => {
  it("shows only when due and something is unsettled", () => {
    expect(showBanner(ledger())).toBe(true);
    expect(showBanner(ledger({ due: false }))).toBe(false);
    expect(showBanner(ledger({ unsettled: 0 }))).toBe(false);
    expect(showBanner(null)).toBe(false);
  });
});

describe("localInputToInstant", () => {
  it("reads the typed time in the plan's zone, whatever the browser's, across a clock change", () => {
    // seed-zone moves from +10 to +11 at 02:00 on 2026-10-04: 01:30 is still +10, 03:30 already +11.
    expect(localInputToInstant("2026-10-04T01:30", ZONE)).toBe("2026-10-03T15:30:00.000Z");
    expect(localInputToInstant("2026-10-04T03:30", ZONE)).toBe("2026-10-03T16:30:00.000Z");
    expect(localInputToInstant("2026-10-28T09:15", ZONE)).toBe("2026-10-27T22:15:00.000Z");
  });
});
