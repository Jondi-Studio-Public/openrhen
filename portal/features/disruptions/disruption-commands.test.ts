import { describe, expect, it, vi } from "vitest";
import type { PortalState, StoredCommitment } from "@/state/portal-state";
import { createSeedState } from "@/state/portal-state";
import {
  endDisruptionNow,
  extendDisruption,
  isOpenEndedDisruption,
  dropDesiredWinCommand
} from "./disruption-commands";

const NOW = new Date("2026-08-30T10:00:00.000Z");

const commitment = {
  id: "drive-mum",
  version: 3,
  title: "Driving Mum to the shops",
  startsAt: "2026-08-30T09:00:00.000Z",
  endsAt: "2026-08-30T22:00:00.000Z",
  status: "confirmed",
  location: "Westfield",
  locationId: "westfield",
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  presence: "blocking",
  origin: "disruption",
  disruptionSource: "family",
  disruptionOpenEnded: true,
  landedAt: "2026-08-30T09:01:00.000Z"
} as unknown as StoredCommitment;

function deps(overrides: Partial<PortalState> = {}) {
  const state = { ...createSeedState(NOW), ...overrides } as PortalState;
  return { state, now: NOW, saveEntityCommand: vi.fn().mockResolvedValue(undefined) };
}

describe("isOpenEndedDisruption", () => {
  it("is true only for a disruption still holding an open, guessed end", () => {
    expect(isOpenEndedDisruption(commitment)).toBe(true);
    expect(isOpenEndedDisruption({ ...commitment, disruptionOpenEnded: false })).toBe(false);
    expect(isOpenEndedDisruption({ ...commitment, origin: "planned" })).toBe(false);
  });
});

describe("endDisruptionNow", () => {
  it("emits one commitment edit preserving the record and setting endsAt to now, open-endedness cleared", async () => {
    const d = deps();
    expect(await endDisruptionNow(commitment, d)).toBe("");
    expect(d.saveEntityCommand).toHaveBeenCalledTimes(1);
    const command = d.saveEntityCommand.mock.calls[0]![0];
    expect(command).toMatchObject({
      type: "save_entity",
      entityType: "commitment",
      expectedVersion: 3,
      entity: {
        id: "drive-mum",
        title: "Driving Mum to the shops",
        location: "Westfield",
        locationId: "westfield",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0,
        presence: "blocking",
        status: "confirmed",
        endsAt: NOW.toISOString(),
        disruptionOpenEnded: false
      }
    });
    // The provenance fields the ordinary editor never sends stay unsent, so COALESCE on the write
    // side preserves them rather than reading silence as an answer.
    for (const field of ["origin", "disruptionSource", "landedAt"]) expect(command.entity).not.toHaveProperty(field);
  });

  it("floors the end a minute after the start when now has not caught up with it yet", async () => {
    const d = deps();
    const futureStart = { ...commitment, startsAt: "2026-08-30T10:30:00.000Z" };
    expect(await endDisruptionNow(futureStart, d)).toBe("");
    expect(d.saveEntityCommand.mock.calls[0]![0].entity.endsAt).toBe("2026-08-30T10:31:00.000Z");
  });

  it("returns the server's reason when the command is rejected", async () => {
    const d = deps();
    d.saveEntityCommand.mockRejectedValue(new Error("This record changed elsewhere. Reload before saving."));
    expect(await endDisruptionNow(commitment, d)).toBe("This record changed elsewhere. Reload before saving.");
  });

  it("falls back to its own sentence when the rejection is not an Error", async () => {
    const d = deps();
    d.saveEntityCommand.mockRejectedValue("nope");
    expect(await endDisruptionNow(commitment, d)).toBe("The disruption was not ended.");
  });
});

describe("extendDisruption", () => {
  it("moves endsAt forward by the given minutes and stays open-ended", async () => {
    const d = deps();
    expect(await extendDisruption(commitment, 60, d)).toBe("");
    const entity = d.saveEntityCommand.mock.calls[0]![0].entity;
    expect(entity.endsAt).toBe("2026-08-30T23:00:00.000Z");
    expect(entity.disruptionOpenEnded).toBe(true);
  });

  it("moves endsAt backward for a negative adjustment — 'it's wrapping up'", async () => {
    const d = deps();
    expect(await extendDisruption(commitment, -30, d)).toBe("");
    expect(d.saveEntityCommand.mock.calls[0]![0].entity.endsAt).toBe("2026-08-30T21:30:00.000Z");
  });

  it("floors the shrunk end a minute after the start rather than crossing it", async () => {
    const d = deps();
    const short = { ...commitment, startsAt: "2026-08-30T21:00:00.000Z", endsAt: "2026-08-30T21:10:00.000Z" };
    expect(await extendDisruption(short, -30, d)).toBe("");
    expect(d.saveEntityCommand.mock.calls[0]![0].entity.endsAt).toBe("2026-08-30T21:01:00.000Z");
  });

  it("returns the server's reason when the command is rejected", async () => {
    const d = deps();
    d.saveEntityCommand.mockRejectedValue(new Error("The database is unreachable."));
    expect(await extendDisruption(commitment, 60, d)).toBe("The database is unreachable.");
  });

  it("preserves a closed-end disruption as closed-end when shortened (report: 'Shorten' must not open-end it)", async () => {
    const d = deps();
    const closedEnd = { ...commitment, disruptionOpenEnded: false };
    expect(await extendDisruption(closedEnd, -30, d)).toBe("");
    const entity = d.saveEntityCommand.mock.calls[0]![0].entity;
    expect(entity.endsAt).toBe("2026-08-30T21:30:00.000Z");
    expect(entity.disruptionOpenEnded).toBe(false);
  });

  it("keeps an open-ended disruption open-ended when shortened", async () => {
    const d = deps();
    const openEnd = { ...commitment, disruptionOpenEnded: true };
    expect(await extendDisruption(openEnd, -30, d)).toBe("");
    expect(d.saveEntityCommand.mock.calls[0]![0].entity.disruptionOpenEnded).toBe(true);
  });
});

describe("dropDesiredWinCommand", () => {
  it("removes one action from today's desired wins by rewriting the daily_plan entity", () => {
    const existingPlan = {
      id: "daily-plan-2026-08-30",
      version: 2,
      localDate: "2026-08-30",
      desiredActionIds: ["a1", "a2", "a3"],
      recoverySkipped: false,
      deferredItems: [{ actionId: "a4", reason: "Ran out of time" }]
    };
    const command = dropDesiredWinCommand("a2", "2026-08-30", existingPlan);
    expect(command.expectedVersion).toBe(2);
    expect(command.entityType).toBe("daily_plan");
    expect(command.entity).toMatchObject({
      localDate: "2026-08-30",
      desiredActionIds: ["a1", "a3"],
      deferredItems: [{ actionId: "a4", reason: "Ran out of time" }]
    });
  });

  it("saves against no expected version when no daily plan is stored yet", () => {
    const command = dropDesiredWinCommand("a1", "2026-08-30", undefined);
    expect(command.expectedVersion).toBeNull();
    expect(command.entity.desiredActionIds).toEqual([]);
    expect(command.entity.deferredItems).toEqual([]);
  });

  it("carries through the existing deferredItems untouched", () => {
    const existingPlan = {
      id: "daily-plan-2026-08-30",
      version: 1,
      localDate: "2026-08-30",
      desiredActionIds: ["a1"],
      recoverySkipped: false,
      deferredItems: [
        { actionId: "a2", reason: "Blocked by meeting" },
        { actionId: "a3", reason: "No time left" }
      ]
    };
    const command = dropDesiredWinCommand("a1", "2026-08-30", existingPlan);
    expect(command.entity.deferredItems).toEqual([
      { actionId: "a2", reason: "Blocked by meeting" },
      { actionId: "a3", reason: "No time left" }
    ]);
  });
});
