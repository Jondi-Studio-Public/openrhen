import { describe, expect, it } from "vitest";
import type { ReplayCase, ReplayInput } from "./replay-case.js";
import { LANES, probeTitle, referenceReconciler } from "./replay-reference.js";
import { adversarial, never, oracle } from "./replay-stubs.js";
import { goldenCases } from "./replay-suite.js";

const byId = (id: string): ReplayCase => goldenCases.find((c) => c.id === id)!;
const run = (id: string, chooser = never) => referenceReconciler(structuredClone(byId(id).input), { chooser });

describe("reference reconciler", () => {
  it("derives a title from the quote without filler words", () => {
    expect(probeTitle("Confirming the team sync")).toBe("team sync");
    expect(probeTitle("Please confirm")).toBe("please confirm");
  });

  it("has a lane for every fact type", () => {
    expect(Object.keys(LANES).sort()).toEqual(["ask", "commitment", "deadline", "event"]);
  });

  it("asks on two equal strong matches, with both as candidates and no target", () => {
    const outcome = run("event-twin-records");
    expect(outcome).toMatchObject({ endState: "asked", reason: "tie", tie: true, usedChooser: false });
    expect(outcome.target).toBeUndefined();
    expect(outcome.candidates.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("does not hand a tie to a chooser, even an adversarial one", () => {
    const outcome = run("event-twin-records", adversarial);
    expect(outcome).toMatchObject({ endState: "asked", tie: true, usedChooser: false });
  });

  it("asks on equal deadline fits instead of taking the first", () => {
    expect(run("deadline-numbered-prefix")).toMatchObject({ endState: "asked", tie: true });
  });

  it("reads a moved deadline and a rescheduled event as new", () => {
    expect(run("deadline-moved")).toMatchObject({ endState: "applied", op: "create" });
    expect(run("event-reschedule")).toMatchObject({ endState: "applied", op: "create" });
    expect(run("deadline-moved").candidates.map((c) => c.id)).toContain("a1");
  });

  it("holds a possible match as a question without a chooser", () => {
    expect(run("recurring-neighbour-time-changed")).toMatchObject({
      endState: "asked",
      usedChooser: false,
      tie: false
    });
  });

  it("lets a chooser resolve a possible match, and validates its pick", () => {
    const id = "recurring-neighbour-time-changed";
    expect(run(id, oracle(byId(id).gold))).toMatchObject({
      endState: "duplicate",
      target: { id: "c2" },
      usedChooser: true,
      chooserPick: "c1"
    });
    expect(run("ask-same-thread-new-ask", oracle(byId("ask-same-thread-new-ask").gold))).toMatchObject({
      endState: "applied",
      op: "create",
      chooserPick: "none"
    });
    expect(run(id, () => "c9")).toMatchObject({ endState: "asked", chooserPick: "unsure", usedChooser: true });
    expect(run(id, () => "unsure").endState).toBe("asked");
  });

  it("never lets an adversarial chooser apply", () => {
    for (const c of goldenCases) {
      const outcome = referenceReconciler(structuredClone(c.input), { chooser: adversarial });
      const baseline = referenceReconciler(structuredClone(c.input), { chooser: never });
      if (outcome.endState === "applied") expect(baseline.endState, c.id).toBe("applied");
    }
  });

  it("does not call a chooser when one is not needed", () => {
    const explode = () => {
      throw new Error("called");
    };
    expect(() => run("event-new", explode)).not.toThrow();
    expect(() => run("event-reworded-confirmation", explode)).not.toThrow();
  });

  it("answers no effect, unresolved and cancellations", () => {
    expect(run("event-in-the-past")).toMatchObject({ endState: "no_effect", reason: "past" });
    expect(run("message-without-facts")).toMatchObject({ endState: "no_effect", reason: "no_facts" });
    expect(run("event-no-start-time")).toMatchObject({ endState: "unresolved", reason: "no_start_time" });
    expect(run("event-cancel")).toMatchObject({ endState: "applied", op: "cancel", target: { id: "c1" } });
    expect(run("event-cancel-unknown")).toMatchObject({ endState: "no_effect", reason: "nothing_to_cancel" });
  });

  it("shows at most five candidates, best rank first", () => {
    const input: ReplayInput = structuredClone(byId("event-twin-records").input);
    input.plan.commitments = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`,
      title: "Team sync",
      startsAt: "2026-11-12T10:00:00Z",
      endsAt: "2026-11-12T11:00:00Z",
      allDay: false,
      status: "scheduled",
      contactId: null
    }));
    const outcome = referenceReconciler(input, { chooser: never });
    expect(outcome.candidates).toHaveLength(5);
    expect(outcome.candidates.every((c) => c.rank === 2)).toBe(true);
  });

  it("matches all-day facts on the local date in the plan's timezone", () => {
    const input = structuredClone(byId("event-all-day").input);
    input.timezone = "Pacific/Auckland";
    expect(referenceReconciler(input, { chooser: never })).toMatchObject({
      endState: "duplicate",
      target: { id: "c1" }
    });
  });
});
