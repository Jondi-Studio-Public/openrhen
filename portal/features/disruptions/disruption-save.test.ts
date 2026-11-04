import { describe, expect, it, vi } from "vitest";
import type { PortalState } from "@/state/portal-state";
import { createSeedState } from "@/state/portal-state";
import { disruptionContextFrom, emptyDisruptionDraft, type DisruptionDraft } from "./disruption-draft";
import { saveDisruptionDraft } from "./disruption-save";

const NOW = new Date("2026-08-30T04:00:00.000Z");

function deps(overrides: Partial<PortalState> = {}) {
  const state = { ...createSeedState(NOW), ...overrides } as PortalState;
  return {
    state,
    now: NOW,
    saveEntityCommand: vi.fn().mockResolvedValue(undefined),
    runActivityCommand: vi.fn().mockResolvedValue(undefined),
    track: true
  };
}

const draftOf = (state: PortalState, overrides: Partial<DisruptionDraft> = {}): DisruptionDraft => ({
  ...emptyDisruptionDraft(disruptionContextFrom(state, NOW)),
  title: "Driving Mum to the shops",
  ...overrides
});

describe("saveDisruptionDraft", () => {
  /**
   * The whole point of the feature, as one assertion: a disruption is a confirmed commitment, not a
   * capture. A capture would sit in Needs review changing nothing while the day it already took went
   * on being planned as though it were free.
   */
  it("writes a confirmed commitment carrying its disruption provenance", async () => {
    const d = deps();
    expect(await saveDisruptionDraft(draftOf(d.state), d)).toEqual({ error: "", trackingError: "" });
    expect(d.saveEntityCommand).toHaveBeenCalledTimes(1);
    expect(d.saveEntityCommand.mock.calls[0]![0]).toMatchObject({
      type: "save_entity",
      entityType: "commitment",
      expectedVersion: null,
      entity: {
        title: "Driving Mum to the shops",
        status: "confirmed",
        origin: "disruption",
        disruptionSource: "other",
        landedAt: NOW.toISOString()
      }
    });
    expect(d.saveEntityCommand.mock.calls[0]![0].entity.id).toBeTruthy();
  });

  it("refuses an unnamed draft and sends nothing", async () => {
    const d = deps();
    expect(await saveDisruptionDraft(draftOf(d.state, { title: "  " }), d)).toEqual({
      error: "A disruption needs a name.",
      trackingError: ""
    });
    expect(d.saveEntityCommand).not.toHaveBeenCalled();
    expect(d.runActivityCommand).not.toHaveBeenCalled();
  });

  it("returns the server's reason when the command is rejected, and never starts tracking", async () => {
    const d = deps();
    d.saveEntityCommand.mockRejectedValue(new Error("The database is unreachable."));
    expect(await saveDisruptionDraft(draftOf(d.state), d)).toEqual({
      error: "The database is unreachable.",
      trackingError: ""
    });
    expect(d.runActivityCommand).not.toHaveBeenCalled();
  });

  it("falls back to its own sentence when the rejection is not an Error", async () => {
    const d = deps();
    d.saveEntityCommand.mockRejectedValue("nope");
    expect(await saveDisruptionDraft(draftOf(d.state), d)).toEqual({
      error: "The disruption was not saved.",
      trackingError: ""
    });
  });

  /**
   * The point of the whole tracking half: a disruption logged as happening right now, with the
   * checkbox on, opens a session on the very commitment it just wrote — in that order, and for the
   * minutes actually left in its window rather than the window's full length.
   */
  it("starts tracking after the save, for the minutes left in a live window", async () => {
    const d = deps();
    // "now" (delay 0), duration "1h" — live from 04:00 to 05:00, and NOW is exactly its start.
    const outcome = await saveDisruptionDraft(draftOf(d.state), d);
    expect(outcome).toEqual({ error: "", trackingError: "" });
    expect(d.saveEntityCommand).toHaveBeenCalledTimes(1);
    expect(d.runActivityCommand).toHaveBeenCalledTimes(1);
    const savedId = d.saveEntityCommand.mock.calls[0]![0].entity.id as string;
    expect(d.runActivityCommand.mock.calls[0]![0]).toMatchObject({
      type: "start_activity",
      targetType: "fixed_commitment",
      targetId: savedId,
      phase: "active",
      expectedVersion: 1,
      plannedMinutes: 60
    });
    // Order: the save resolved before the activity command was ever sent.
    const saveOrder = d.saveEntityCommand.mock.invocationCallOrder[0]!;
    const activityOrder = d.runActivityCommand.mock.invocationCallOrder[0]!;
    expect(saveOrder).toBeLessThan(activityOrder);
  });

  it("sends only the save for a retro-logged disruption that has already ended", async () => {
    const d = deps();
    // Logged as having started two hours ago and lasting an hour: already over by NOW.
    const outcome = await saveDisruptionDraft(
      draftOf(d.state, { when: "earlier", earlierTime: "02:00", duration: "1h" }),
      d
    );
    expect(outcome).toEqual({ error: "", trackingError: "" });
    expect(d.saveEntityCommand).toHaveBeenCalledTimes(1);
    expect(d.runActivityCommand).not.toHaveBeenCalled();
  });

  it("sends only the save for a disruption that has not started yet", async () => {
    const d = deps();
    const outcome = await saveDisruptionDraft(draftOf(d.state, { when: "in_60" }), d);
    expect(outcome).toEqual({ error: "", trackingError: "" });
    expect(d.saveEntityCommand).toHaveBeenCalledTimes(1);
    expect(d.runActivityCommand).not.toHaveBeenCalled();
  });

  it("sends only the save when the checkbox was off", async () => {
    const d = deps();
    d.track = false;
    const outcome = await saveDisruptionDraft(draftOf(d.state), d);
    expect(outcome).toEqual({ error: "", trackingError: "" });
    expect(d.saveEntityCommand).toHaveBeenCalledTimes(1);
    expect(d.runActivityCommand).not.toHaveBeenCalled();
  });

  it("sends only the save when another activity is already running, even if track is on", async () => {
    const d = deps({
      activeSession: {
        id: "session-1",
        actionId: "action-1",
        status: "running",
        targetType: "deliverable",
        targetTitle: "Something else",
        startedAt: NOW.toISOString(),
        plannedEndAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
        plannedMinutes: 30,
        remainingBeforeMinutes: 30,
        activeElapsedSeconds: 0
      } as PortalState["activeSession"]
    });
    const outcome = await saveDisruptionDraft(draftOf(d.state), d);
    expect(outcome).toEqual({ error: "", trackingError: "" });
    expect(d.saveEntityCommand).toHaveBeenCalledTimes(1);
    expect(d.runActivityCommand).not.toHaveBeenCalled();
  });

  it("reports a tracking failure without undoing or retrying the save", async () => {
    const d = deps();
    d.runActivityCommand.mockRejectedValue(new Error("Another activity is already open."));
    const outcome = await saveDisruptionDraft(draftOf(d.state), d);
    expect(outcome.error).toBe("");
    expect(outcome.trackingError).toContain("Another activity is already open.");
    expect(d.saveEntityCommand).toHaveBeenCalledTimes(1);
    expect(d.runActivityCommand).toHaveBeenCalledTimes(1);
  });
});
