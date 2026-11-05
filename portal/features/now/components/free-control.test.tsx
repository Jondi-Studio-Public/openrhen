// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSeedState, type StoredCommitment } from "@/state/portal-state";
import { fireEvent, render, screen, waitFor } from "@/test/render";
import type { NowOpenAnchor, NowProtectedCommitment } from "@/features/now/now-model";
import { canBeFreed } from "@/features/now/free-commitment";
import { EngagementStrip } from "./engagement-strip";
import { FreeControl } from "./free-control";
import { ProtectedCommitmentPanel } from "./protected-commitment-panel";

const now = new Date("2026-08-18T10:00:00.000Z");
const state = createSeedState(now);
const minutes = (offset: number) => new Date(now.getTime() + offset * 60_000);
const soccer = (overrides: Partial<StoredCommitment> = {}): StoredCommitment => ({
  ...state.commitments[0]!,
  id: "soccer",
  title: "Soccer",
  status: "confirmed",
  startsAt: minutes(-60).toISOString(),
  endsAt: minutes(120).toISOString(),
  version: 6,
  ...overrides
});
const window: NowProtectedCommitment = {
  id: "soccer",
  title: "Soccer",
  phase: "active",
  startsAt: minutes(-60),
  endsAt: minutes(120),
  protectedStartAt: minutes(-60),
  protectedEndAt: minutes(120),
  phaseStartsAt: minutes(-60),
  phaseEndsAt: minutes(120)
};

describe("canBeFreed", () => {
  it("is offered from the start to the end of a confirmed commitment only", () => {
    expect(canBeFreed(soccer(), now)).toBe(true);
    expect(canBeFreed(soccer({ startsAt: minutes(5).toISOString() }), now)).toBe(false);
    expect(canBeFreed(soccer({ endsAt: minutes(-1).toISOString() }), now)).toBe(false);
    expect(canBeFreed(soccer({ status: "tentative" }), now)).toBe(false);
  });
});

describe("FreeControl", () => {
  it("sends free alone at the version it read", async () => {
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <FreeControl
        commitment={soccer()}
        awaitingRecalculation={false}
        saving={false}
        saveEntityCommand={saveEntityCommand}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "I’m free" }));
    await waitFor(() => expect(saveEntityCommand).toHaveBeenCalledTimes(1));
    expect(saveEntityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "save_entity",
        entityType: "commitment",
        expectedVersion: 6,
        entity: { id: "soccer", free: true }
      })
    );
  });

  it("shows the pending state while the plan recalculates, and offers the way back", async () => {
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <FreeControl
        commitment={soccer({ freedFrom: minutes(-1).toISOString() })}
        awaitingRecalculation
        saving={false}
        saveEntityCommand={saveEntityCommand}
      />
    );
    expect(screen.getByText(/You’re free of Soccer/)).toBeTruthy();
    expect(screen.getByText(/Working out what’s next/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "I’m free" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Undo — I’m still in it" }));
    await waitFor(() =>
      expect(saveEntityCommand).toHaveBeenCalledWith(expect.objectContaining({ entity: { id: "soccer", free: false } }))
    );
  });

  it("says so when the save is refused", async () => {
    const saveEntityCommand = vi.fn().mockRejectedValue(new Error("It has already ended."));
    render(
      <FreeControl
        commitment={soccer()}
        awaitingRecalculation={false}
        saving={false}
        saveEntityCommand={saveEntityCommand}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "I’m free" }));
    expect(await screen.findByText("It has already ended.")).toBeTruthy();
  });
});

describe("the Now card", () => {
  it("puts I’m free on the protected commitment's card", () => {
    render(
      <ProtectedCommitmentPanel
        protectedCommitment={window}
        storedProtectedCommitment={soccer()}
        state={state}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        explanation="Soccer holds this time."
        evidence={[]}
        runActivityCommand={vi.fn().mockResolvedValue(undefined)}
        saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
      />
    );
    expect(screen.getByRole("button", { name: "I’m free" })).toBeTruthy();
  });

  it("does not offer it before the commitment starts", () => {
    render(
      <ProtectedCommitmentPanel
        protectedCommitment={window}
        storedProtectedCommitment={soccer({ startsAt: minutes(30).toISOString() })}
        state={state}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        explanation="Soccer holds this time."
        evidence={[]}
        runActivityCommand={vi.fn().mockResolvedValue(undefined)}
        saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
      />
    );
    expect(screen.queryByRole("button", { name: "I’m free" })).toBeNull();
  });

  it("hides the dead engagement button for an open anchor the person has freed", () => {
    const openAnchor: NowOpenAnchor = { ...window };
    render(
      <EngagementStrip
        openAnchor={openAnchor}
        storedOpenAnchor={soccer({ freedFrom: minutes(-1).toISOString() })}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        runActivityCommand={vi.fn().mockResolvedValue(undefined)}
      />
    );
    expect(screen.queryByRole("button", { name: /engaged/ })).toBeNull();
    expect(screen.getByText(/You’re free of/)).toBeTruthy();
  });
});
